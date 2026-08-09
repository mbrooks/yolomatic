import { execFile as execFileCallback, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";

import type { SettingsStore } from "../settings/store.js";

const execFileDefault = promisify(execFileCallback);

/** Default Ollama container name (matches the `yolomatic-ollama` service in docker-compose.yml). */
export const DEFAULT_OLLAMA_CONTAINER_NAME = "yolomatic-ollama";

/** Bounded timeout for the non-interactive `ollama signin` invocation. */
export const DEFAULT_OLLAMA_SIGNIN_TIMEOUT_MS = 8000;

/**
 * Generic env var that enables debug logging. When set to a truthy value
 * (1/true/yes), the default debug logger writes the issued command and the
 * captured result to stdout, so a maintainer can see exactly what
 * `docker exec ... ollama signin` returned instead of guessing. Defaults to
 * `false` (debugging off) when unset.
 */
export const DEBUG_LOG_ENV = "DEBUG_LOG";

/** Truncation limit for stdout/stderr captured in debug log lines. */
const DEBUG_OUTPUT_LIMIT = 2000;

/** Debug logger: receives human-readable lines describing the command + result. */
export type OllamaDebugLogger = (message: string) => void;

/**
 * Build the default debug logger. Reads {@link DEBUG_LOG_ENV} once so the
 * enable decision is fixed for the lifetime of the returned logger. Defaults
 * to disabled (`false`) when the env var is unset.
 * Exported for unit tests; production callers should pass `options.debug` or
 * let `checkOllamaSignInStatus` construct this lazily.
 */
export function createOllamaDebugLogger(
	env: NodeJS.ProcessEnv = process.env,
): OllamaDebugLogger {
	const enabled = /^(1|true|yes)$/iu.test(String(env[DEBUG_LOG_ENV] ?? "false").trim());
	return (message: string): void => {
		if (!enabled) return;
		process.stdout.write(`[ollama-signin] ${message}\n`);
	};
}

function truncateForLog(value: string): string {
	const single = value.replace(/\r?\n/g, "\\n");
	return single.length > DEBUG_OUTPUT_LIMIT ? `${single.slice(0, DEBUG_OUTPUT_LIMIT)}...` : single;
}

export interface OllamaSignInResult {
	/** Whether the Ollama account is registered / signed in. */
	signedIn: boolean;
	/** Redacted username from the "already signed in" line, when present. */
	user?: string;
	/** `https://ollama.com/connect?...` URL printed when the account is not signed in. */
	signInUrl?: string;
	/** Human-readable status text (raw command output or a friendly summary). */
	message: string;
	/** Present when the container is missing, Docker is unavailable, the check times out, etc. */
	error?: string;
}

/** A promisified `execFile`-shaped function (injectable for tests). */
export type OllamaExecFile = (
	file: string,
	args: readonly string[],
	options?: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer } | string>;

export interface OllamaSignInOptions {
	containerName: string;
	/** Override the bounded timeout (defaults to {@link DEFAULT_OLLAMA_SIGNIN_TIMEOUT_MS}). */
	timeoutMs?: number;
	/** Inject an `execFile` implementation (defaults to promisified `node:child_process`). */
	execFile?: OllamaExecFile;
	/** Inject a debug logger (defaults to {@link createOllamaDebugLogger}, env-gated). */
	debug?: OllamaDebugLogger;
}

/**
 * Parse the textual output of `ollama signin` into a structured result.
 * Handles both the "already signed in" and "you need to be signed in"
 * (with the connect URL) shapes reported by the Ollama CLI.
 */
export function parseOllamaSignInOutput(output: string): OllamaSignInResult {
	const text = output.trim();
	if (!text) {
		return { signedIn: false, message: "" };
	}

	const signedInMatch = text.match(/You are already signed in as user ['"]([^'"]+)['"]/u);
	if (signedInMatch) {
		return { signedIn: true, user: signedInMatch[1], message: text };
	}

	const urlMatch = text.match(/(https:\/\/ollama\.com\/connect\?[^\s)"']+)/u);
	const needsSignIn = /need to be signed in/i.test(text);
	if (urlMatch || needsSignIn) {
		return {
			signedIn: false,
			...(urlMatch ? { signInUrl: urlMatch[1] } : {}),
			message: text,
		};
	}

	return { signedIn: false, message: text };
}

function asString(value: string | Buffer | undefined): string {
	if (value === undefined) return "";
	return typeof value === "string" ? value : value.toString("utf8");
}

function isTimeoutError(error: unknown): boolean {
	const err = error as Partial<ExecFileException> & { killed?: boolean };
	if (err.killed === true && err.signal === "SIGTERM") {
		return true;
	}
	const message = err instanceof Error ? err.message : String(err ?? "");
	return /timed out/i.test(message);
}

/**
 * Check Ollama sign-in status by invoking `ollama signin` inside the Ollama
 * container via the Docker socket. Runs non-interactively (no `-it`) so it
 * works when stdin is not a terminal (e.g. when driven by the control
 * plane); bounded timeout so a blocking OAuth wait is killed.
 */
export async function checkOllamaSignInStatus(options: OllamaSignInOptions): Promise<OllamaSignInResult> {
	const containerName = options.containerName.trim();
	if (!containerName) {
		return {
			signedIn: false,
			message: "Ollama container name is not configured.",
			error: "missing container name",
		};
	}

	const timeoutMs = options.timeoutMs ?? DEFAULT_OLLAMA_SIGNIN_TIMEOUT_MS;
	const exec = options.execFile ?? execFileDefault;
	const debug = options.debug ?? createOllamaDebugLogger();

	const args = ["exec", containerName, "ollama", "signin"];
	debug(`issuing: docker ${args.join(" ")} (timeout ${timeoutMs}ms)`);

	try {
		const result = await exec(
			"docker",
			args,
			{ timeout: timeoutMs, maxBuffer: 1024 * 1024 },
		);
		const stdout = typeof result === "string" ? result : asString(result.stdout);
		const stderr = typeof result === "string" ? "" : asString(result.stderr);
		debug(`result: exit 0; stdout=${truncateForLog(stdout)}; stderr=${truncateForLog(stderr)}`);
		return parseOllamaSignInOutput(`${stdout}\n${stderr}`);
	} catch (error) {
		const err = error as Partial<ExecFileException> & {
			stdout?: Buffer | string;
			stderr?: Buffer | string;
			code?: string | number;
			signal?: string;
			killed?: boolean;
		};

		const stdout = asString(err.stdout);
		const stderr = asString(err.stderr);
		const combined = `${stdout}\n${stderr}`.trim();

		debug(
			`result: error code=${String(err.code ?? "?")} signal=${String(err.signal ?? "?")}` +
				` killed=${String(err.killed ?? false)}; stdout=${truncateForLog(stdout)};` +
				` stderr=${truncateForLog(stderr)}; message=${truncateForLog(err instanceof Error ? err.message : String(error ?? ""))}`,
		);

		// `ollama signin` prints the connect URL (or the "already signed in" line)
		// and then blocks waiting for the browser OAuth flow to complete. When
		// our bounded timeout kills it, the buffered stdout/stderr still holds
		// that output, so parse it before classifying the failure. This also
		// covers a non-zero exit that still produced a usable sign-in URL.
		if (combined) {
			const parsed = parseOllamaSignInOutput(combined);
			if (parsed.signedIn || parsed.signInUrl) {
				return parsed;
			}
		}

		if (err.code === "ENOENT") {
			return {
				signedIn: false,
				message: "Docker is not available on the control plane host.",
				error: "docker unavailable",
			};
		}

		if (isTimeoutError(error)) {
			return {
				signedIn: false,
				message: `Ollama sign-in check timed out after ${timeoutMs} ms.`,
				error: "timeout",
			};
		}

		if (combined) {
			if (/no such container/i.test(combined) || /not found/i.test(combined)) {
				return {
					signedIn: false,
					message: `Ollama container "${containerName}" was not found.`,
					error: combined,
				};
			}
			return { signedIn: false, message: parseOllamaSignInOutput(combined).message, error: combined };
		}

		const message = err instanceof Error ? err.message : String(error ?? "Ollama sign-in check failed.");
		return { signedIn: false, message, error: message };
	}
}

export interface OllamaSignInService {
	checkSignInStatus(options?: { containerName?: string }): Promise<OllamaSignInResult>;
}

/**
 * Thin service that resolves the Ollama container name from settings and
 * delegates to {@link checkOllamaSignInStatus}. Kept small so the admin
 * route handler can stay thin and the Docker invocation stays unit-testable.
 */
export class DefaultOllamaSignInService implements OllamaSignInService {
	constructor(
		private readonly settingsStore: SettingsStore,
		private readonly execFile?: OllamaExecFile,
		private readonly debug?: OllamaDebugLogger,
	) {}

	async checkSignInStatus(options?: { containerName?: string }): Promise<OllamaSignInResult> {
		const configured = options?.containerName?.trim();
		const containerName = configured || this.settingsStore.getString("ollama_container_name", DEFAULT_OLLAMA_CONTAINER_NAME);
		return checkOllamaSignInStatus({ containerName, execFile: this.execFile, debug: this.debug });
	}
}