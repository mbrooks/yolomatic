import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * Worker environment initialization.
 *
 * Runs a repository-provided init script (default: `yeetstrap.sh` at the
 * workspace root) deterministically, before the agent starts, so the
 * environment is in a known state before the first model turn. See
 * `design/worker-env-init.md` for the full contract.
 */

export type EnvInitLogLevel = "info" | "warn" | "error";

export interface EnvInitLogEntry {
	level: EnvInitLogLevel;
	message: string;
	details?: Record<string, unknown>;
}

export type EnvInitLogFn = (entry: EnvInitLogEntry) => void;

export interface EnvironmentInitOptions {
	/** Absolute path to the workspace the script runs against. */
	workspacePath: string;
	/**
	 * Override the init script path. Defaults to `YEETOMATIC_WORKER_INIT_SCRIPT`
	 * or `yeetstrap.sh`. Relative paths resolve against the workspace path.
	 */
	scriptPath?: string;
	/** Skip the init phase entirely. Defaults from `YEETOMATIC_WORKER_INIT_SKIP`. */
	skip?: boolean;
	/** Wall-clock timeout in seconds. Defaults from `YEETOMATIC_WORKER_INIT_TIMEOUT_SECONDS` or 1800. */
	timeoutSeconds?: number;
	/** Streamed log emitter for stdout/stderr. */
	log: EnvInitLogFn;
	/** Abort signal; aborting kills the script and rejects with `aborted`. */
	signal?: AbortSignal;
	/** Environment read for config and passed to the script. Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
}

export interface EnvironmentInitResult {
	skipped: boolean;
	scriptPath?: string;
}

export type EnvInitErrorKind =
	| "invalid_script"
	| "nonzero_exit"
	| "signal"
	| "timeout"
	| "aborted"
	| "spawn_failed";

export interface EnvInitErrorOptions {
	kind: EnvInitErrorKind;
	message: string;
	exitCode?: number;
	signal?: string;
	stderrTail?: string;
}

export class EnvInitError extends Error {
	public readonly kind: EnvInitErrorKind;
	public readonly exitCode?: number;
	public readonly signal?: string;
	public readonly stderrTail?: string;

	public constructor(opts: EnvInitErrorOptions) {
		super(opts.message);
		this.name = "EnvInitError";
		this.kind = opts.kind;
		this.exitCode = opts.exitCode;
		this.signal = opts.signal;
		this.stderrTail = opts.stderrTail;
	}
}

const DEFAULT_TIMEOUT_SECONDS = 1800;
const DEFAULT_SCRIPT_NAME = "yeetstrap.sh";
const STDERR_TAIL_BYTES = 4096;

function parseSkip(value: string | undefined): boolean {
	const v = value?.trim().toLowerCase();
	return v === "1" || v === "true";
}

function parseTimeout(value: string | undefined, fallback: number): number {
	const raw = value?.trim();
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveInitScriptPath(workspacePath: string, scriptPathRaw: string): string {
	return path.isAbsolute(scriptPathRaw) ? scriptPathRaw : path.resolve(workspacePath, scriptPathRaw);
}

export async function runEnvironmentInit(options: EnvironmentInitOptions): Promise<EnvironmentInitResult> {
	const env = options.env ?? process.env;
	const skip = options.skip ?? parseSkip(env.YEETOMATIC_WORKER_INIT_SKIP);
	const timeoutSeconds =
		options.timeoutSeconds ?? parseTimeout(env.YEETOMATIC_WORKER_INIT_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS);
	const scriptPathRaw =
		options.scriptPath ?? (env.YEETOMATIC_WORKER_INIT_SCRIPT?.trim() || DEFAULT_SCRIPT_NAME);
	const scriptPath = resolveInitScriptPath(options.workspacePath, scriptPathRaw);

	if (skip) {
		return { skipped: true };
	}

	if (options.signal?.aborted) {
		throw new EnvInitError({ kind: "aborted", message: "Init aborted before script started" });
	}

	let stats;
	try {
		stats = await stat(scriptPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return { skipped: true };
		}
		if (code === "EACCES") {
			throw new EnvInitError({ kind: "invalid_script", message: `Init script ${scriptPath} is not readable` });
		}
		throw error;
	}

	if (!stats.isFile()) {
		throw new EnvInitError({ kind: "invalid_script", message: `Init script ${scriptPath} is not a regular file` });
	}
	if (stats.size === 0) {
		throw new EnvInitError({ kind: "invalid_script", message: `Init script ${scriptPath} is empty` });
	}

	await spawnInitScript({
		workspacePath: options.workspacePath,
		scriptPath,
		timeoutSeconds,
		log: options.log,
		signal: options.signal,
		env,
	});

	return { skipped: false, scriptPath };
}

interface SpawnInitOptions {
	workspacePath: string;
	scriptPath: string;
	timeoutSeconds: number;
	log: EnvInitLogFn;
	signal?: AbortSignal;
	env: NodeJS.ProcessEnv;
}

function spawnInitScript(options: SpawnInitOptions): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const childEnv: NodeJS.ProcessEnv = { ...options.env };
		// The WebSocket reservation URL is a single-use token the script has no
		// use for; strip it before handing the environment to repository code.
		delete childEnv.YEETOMATIC_SESSION_WS_URL;

		let child: ChildProcess;
		try {
			child = spawn(
				"bash",
				["-c", `cd "${options.workspacePath}" && exec bash -- "${options.scriptPath}"`],
				{
					cwd: options.workspacePath,
					env: childEnv,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
		} catch (error) {
			reject(
				new EnvInitError({
					kind: "spawn_failed",
					message: `Failed to spawn init script: ${error instanceof Error ? error.message : String(error)}`,
				}),
			);
			return;
		}

		let stderrTail = "";
		let settled = false;
		let timer: NodeJS.Timeout | undefined;

		const cleanup = () => {
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			options.signal?.removeEventListener("abort", onAbort);
			child.removeAllListeners();
			child.stdout?.removeAllListeners();
			child.stderr?.removeAllListeners();
		};

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			fn();
		};

		const onAbort = () => {
			child.kill("SIGKILL");
			finish(() => reject(new EnvInitError({ kind: "aborted", message: "Init script aborted" })));
		};

		timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(() =>
				reject(
					new EnvInitError({
						kind: "timeout",
						message: `Init script exceeded ${options.timeoutSeconds}s timeout`,
						stderrTail,
					}),
				),
			);
		}, options.timeoutSeconds * 1000);
		timer.unref?.();

		if (options.signal?.aborted) {
			onAbort();
			return;
		}
		options.signal?.addEventListener("abort", onAbort);

		child.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			if (text.length > 0) {
				options.log({ level: "info", message: text, details: { type: "env_init" } });
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stderrTail = appendTail(stderrTail, text);
			if (text.length > 0) {
				options.log({ level: "warn", message: text, details: { type: "env_init" } });
			}
		});

		child.on("error", (error) => {
			finish(() =>
				reject(
					new EnvInitError({
						kind: "spawn_failed",
						message: `Init script spawn error: ${error.message}`,
						stderrTail,
					}),
				),
			);
		});

		child.on("exit", (code, signal) => {
			if (signal) {
				finish(() =>
					reject(
						new EnvInitError({
							kind: "signal",
							message: `Init script killed by signal ${signal}`,
							signal: String(signal),
							stderrTail,
						}),
					),
				);
				return;
			}
			if (code !== 0) {
				finish(() =>
					reject(
						new EnvInitError({
							kind: "nonzero_exit",
							message: `Init script exited with code ${code}`,
							exitCode: code ?? undefined,
							stderrTail,
						}),
					),
				);
				return;
			}
			finish(() => resolve());
		});
	});
}

function appendTail(current: string, chunk: string): string {
	const combined = `${current}${chunk}`;
	if (combined.length <= STDERR_TAIL_BYTES) {
		return combined;
	}
	return combined.slice(combined.length - STDERR_TAIL_BYTES);
}