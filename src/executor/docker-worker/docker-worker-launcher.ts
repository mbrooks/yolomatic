import { access } from "node:fs/promises";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { recordSessionLog } from "../../logging/session-log-store.js";
import {
	resolveRuntimeSettings,
	type RuntimeSettings,
	type RuntimeSettingsProvider,
} from "../../runtime-settings.js";
import { resolveLaunchModel, resolveLaunchProvider, type WorkerPromptKind } from "../model-selection.js";
import {
	BASE_WORKER_DOCKERFILE,
	BASE_WORKER_IMAGE,
	DEFAULT_WORKER_TEMPLATE,
	getWorkerTemplate,
	type WorkerTemplate,
} from "../../worker/templates.js";
import type { SessionState } from "../../session/store.js";

const execFileAsync = promisify(execFile);

const WORKER_IMAGE_TRANSPORT_LABEL = "io.yolomatic.worker.transport";
const WORKER_IMAGE_TRANSPORT_VERSION = "websocket-v1";
const MAX_WORKER_LAUNCH_RETRIES = 3;
const MAX_IMAGE_REVALIDATIONS = 3;
const STOPPED_CONTAINER_STATES = new Set(["created", "dead", "exited"]);
/** Matches userinfo credentials embedded in a URL (e.g. https://user:token@host). */
const CREDENTIAL_URL_PATTERN = /^[a-z]+:\/\/[^/]*@/i;

async function execFileText(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	const result = await execFileAsync(command, args, { cwd });
	if (typeof result === "string") {
		return { stdout: result, stderr: "" };
	}
	return {
		stdout: String(result.stdout ?? ""),
		stderr: String(result.stderr ?? ""),
	};
}

function appendOutput(current: string, chunk: string): string {
	const combined = `${current}${chunk}`;
	return combined.length > 4000 ? combined.slice(combined.length - 4000) : combined;
}

export interface DockerWorkerLauncherOptions {
	projectRoot: string;
	workspacesDir: string;
	/** @deprecated Legacy image override retained for a rolling upgrade only. */
	workerImage?: string;
	defaultWorkerTemplate?: string;
	resolveWorkerTemplate?: (owner: string, repo: string) => string;
	workerWorkspaceMountSource: string;
	workerDockerNetworkMode?: string;
	workerOllamaHost?: string;
	/** Optional OpenAI platform API key forwarded to workers as OPENAI_API_KEY. */
	workerOpenAiApiKey?: string;
	soulPath: string;
	/** Runtime settings provider (or static snapshot) supplying model env vars. */
	runtimeSettings?: RuntimeSettingsProvider | (() => RuntimeSettings);
	/**
	 * Live per-repository build-model override: returns the repository's own
	 * override (bare id or `provider/model`), or undefined to inherit the
	 * global model. Read fresh at launch time (no-restart contract).
	 */
	resolveRepoBuildModel?: (owner: string, repo: string) => string | undefined;
}

export interface DockerWorkerLaunchPlan {
	containerName: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
}

export interface DockerWorkerContainerHandle {
	containerName: string;
	docker: ChildProcess;
	/** Rejects when the docker process exits before the session settles. */
	dockerExitPromise: Promise<never>;
	/** Marks the session as settled so docker exit is ignored. */
	markSettled: () => void;
	/** Tail of docker stderr/stdout for diagnostic errors. */
	getOutputTail: () => string;
}

export class DockerWorkerLauncher {
	private readonly imageReady = new Map<string, Promise<void>>();

	appendOutput(current: string, chunk: string): string {
		return appendOutput(current, chunk);
	}

	private baseImageReady?: Promise<void>;
	private resolvedWorkerWorkspaceMountSource?: Promise<string>;

	constructor(private readonly options: DockerWorkerLauncherOptions) {}

	clearImageReadyCache(): void {
		this.imageReady.clear();
		this.baseImageReady = undefined;
	}

	/**
	 * Resolves the runtime settings snapshot used for this launch. Read fresh
	 * on each call so live database-setting updates affect subsequent sessions.
	 */
	private getRuntimeSettings(): RuntimeSettings {
		return resolveRuntimeSettings(this.options.runtimeSettings);
	}

	resolveTemplate(owner?: string, repo?: string): WorkerTemplate {
		const id = owner && repo ? this.options.resolveWorkerTemplate?.(owner, repo) : undefined;
		const requested = id ?? this.options.defaultWorkerTemplate;
		const template = requested ? getWorkerTemplate(requested) : undefined;
		if (template) return template;
		if (this.options.workerImage) {
			return {
				id: "legacy",
				label: "Legacy worker image",
				image: this.options.workerImage,
				dockerfile: "Dockerfile",
			};
		}
		const fallback = getWorkerTemplate(DEFAULT_WORKER_TEMPLATE);
		if (fallback) return fallback;
		throw new Error(`Unknown worker template: ${requested ?? DEFAULT_WORKER_TEMPLATE}`);
	}

	async ensureWorkerImage(workerTemplate: WorkerTemplate, sessionKey: string): Promise<void> {
		for (let attempt = 1; attempt <= MAX_IMAGE_REVALIDATIONS; attempt += 1) {
			const cached = this.imageReady.get(workerTemplate.id);
			if (cached) {
				await cached;
				if (await this.dockerImageExists(workerTemplate.image)) return;

				// A host-side cleanup may remove an image while this process still
				// holds its completed build promise. Only invalidate the promise we
				// inspected so concurrent recovery requests share one replacement.
				if (this.imageReady.get(workerTemplate.id) === cached) {
					this.imageReady.delete(workerTemplate.id);
				}
				continue;
			}

			// Rebuild once per control-plane process so deployments cannot reuse a
			// worker image built from older source. Docker caches unchanged layers.
			recordSessionLog(sessionKey, {
				level: "info",
				message: "Building worker container image; this may take a couple of minutes.",
				details: { type: "worker_image_build", image: workerTemplate.image, template: workerTemplate.id },
			});
			const ready =
				workerTemplate.id === "legacy"
					? execFileAsync(
							"docker",
							[
								"build",
								"--target",
								"worker",
								"--label",
								`${WORKER_IMAGE_TRANSPORT_LABEL}=${WORKER_IMAGE_TRANSPORT_VERSION}`,
								"-t",
								workerTemplate.image,
								this.options.projectRoot,
							],
							{ cwd: this.options.projectRoot },
						).then(() => undefined)
					: this.ensureWorkerBaseImage().then(() =>
							execFileAsync(
								"docker",
								[
									"build",
									"--label",
									`${WORKER_IMAGE_TRANSPORT_LABEL}=${WORKER_IMAGE_TRANSPORT_VERSION}`,
									"-t",
									workerTemplate.image,
									"-f",
									path.join(this.options.projectRoot, workerTemplate.dockerfile),
									this.options.projectRoot,
								],
								{ cwd: this.options.projectRoot },
							).then(() => undefined),
						);
			this.imageReady.set(workerTemplate.id, ready);
			await ready;
			return;
		}

		throw new Error(
			`Worker image ${workerTemplate.image} remained unavailable after ${MAX_IMAGE_REVALIDATIONS} cache revalidation attempts.`,
		);
	}

	async ensureWorkerBaseImage(): Promise<void> {
		for (let attempt = 1; attempt <= MAX_IMAGE_REVALIDATIONS; attempt += 1) {
			const cached = this.baseImageReady;
			if (cached) {
				await cached;
				if (await this.dockerImageExists(BASE_WORKER_IMAGE)) return;

				if (this.baseImageReady === cached) {
					this.baseImageReady = undefined;
				}
				continue;
			}

			const ready = execFileAsync(
				"docker",
				[
					"build",
					"--label",
					`${WORKER_IMAGE_TRANSPORT_LABEL}=${WORKER_IMAGE_TRANSPORT_VERSION}`,
					"-t",
					BASE_WORKER_IMAGE,
					"-f",
					path.join(this.options.projectRoot, BASE_WORKER_DOCKERFILE),
					this.options.projectRoot,
				],
				{ cwd: this.options.projectRoot },
			).then(() => undefined);
			this.baseImageReady = ready;
			await ready;
			return;
		}

		throw new Error(
			`Worker base image ${BASE_WORKER_IMAGE} remained unavailable after ${MAX_IMAGE_REVALIDATIONS} cache revalidation attempts.`,
		);
	}

	async prebuildWorkerImage(): Promise<void> {
		process.stdout.write("[startup] prebuilding worker image...\n");
		try {
			await this.ensureWorkerImage(this.resolveTemplate(), "[startup]");
			process.stdout.write("[startup] worker image prebuilt successfully\n");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[startup] worker image prebuild failed: ${message}\n`);
			this.clearImageReadyCache();
		}
	}

	private async dockerImageExists(image: string): Promise<boolean> {
		try {
			await execFileAsync("docker", ["image", "inspect", image], { cwd: this.options.projectRoot });
			return true;
		} catch {
			return false;
		}
	}

	buildContainerName(state: SessionState, kind?: string): string {
		const prefix = kind === "issue-refinement" ? "yolomatic-refinement" : "yolomatic-session";
		return `${prefix}-${state.owner}-${state.repo}-${state.issueNumber}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
	}

	resolveWorkerWorkspacePath(workspacePath: string): string {
		const relative = path.relative(this.options.workspacesDir, workspacePath);
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(
				`Workspace path ${workspacePath} is outside configured WORKSPACES_DIR ${this.options.workspacesDir}`,
			);
		}
		return path.posix.join(this.getWorkerWorkspacesDir(), ...relative.split(path.sep));
	}

	getWorkerWorkspacesDir(): string {
		return this.options.workspacesDir.split(path.sep).join(path.posix.sep);
	}

	async validateLaunch(workspacePath: string): Promise<void> {
		await access(workspacePath);
		await this.assertWorkspaceRemoteIsSanitized(workspacePath);
	}

	/**
	 * Refuse to launch a worker whose mounted workspace still exposes a
	 * credential-bearing remote.origin.url.
	 */
	private async assertWorkspaceRemoteIsSanitized(workspacePath: string): Promise<void> {
		let url: string;
		try {
			const result = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: workspacePath });
			url = String(typeof result === "string" ? result : result.stdout ?? "").trim();
		} catch {
			return;
		}
		if (url.length === 0 || !CREDENTIAL_URL_PATTERN.test(url)) {
			return;
		}
		throw new Error(
			`[worker] Refusing to launch: workspace remote origin URL contains credentials (${url}). ` +
				"The control plane must sanitize remote.origin.url before launching a worker.",
		);
	}

	resolveWorkerOllamaHost(): string | undefined {
		const explicit = this.options.workerOllamaHost?.trim();
		if (explicit) return explicit;

		const raw = process.env.OLLAMA_HOST?.trim();
		if (!raw) return undefined;

		try {
			const url = new URL(raw);
			if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
				if (this.options.workerDockerNetworkMode?.trim().startsWith("container:")) {
					return url.toString();
				}
				url.hostname = "host.docker.internal";
				return url.toString();
			}
		} catch {
			// Fall back to the raw value below.
		}

		return raw;
	}

	/**
	 * Resolves the OpenAI API key to forward into worker containers. An explicit
	 * option takes precedence; otherwise the injected runtime settings' key
	 * (synced from database settings) is forwarded.
	 */
	resolveWorkerOpenAiApiKey(): string | undefined {
		const explicit = this.options.workerOpenAiApiKey?.trim();
		if (explicit) return explicit;
		return this.getRuntimeSettings().model.openaiApiKey?.trim() || undefined;
	}

	/**
	 * Build the `docker run` argument list for a worker launch.
	 *
	 * `promptKind` selects which configured model is forwarded as
	 * `PI_AGENT_MODEL`: refinement launches use the refinement model, every
	 * other launch uses the build model, and each falls back to the default
	 * model when unset. Launches without a kind are treated as build
	 * sessions.
	 */
	async buildDockerRunArgs(
		containerName: string,
		workerTemplate: WorkerTemplate,
		promptKind?: WorkerPromptKind,
		repo?: { owner: string; repo: string },
	): Promise<string[]> {
		const networkMode = this.options.workerDockerNetworkMode?.trim();
		const workspaceMountSource = await this.resolveWorkerWorkspaceMountSource();
		const workerWorkspacesDir = this.getWorkerWorkspacesDir();
		const args = [
			"run",
			"--rm",
			"--name",
			containerName,
			"--mount",
			this.buildMountSpec(workspaceMountSource, workerWorkspacesDir),
		];

		if (networkMode) {
			args.push("--network", networkMode);
		}
		if (!networkMode?.startsWith("container:")) {
			args.push("--add-host", "host.docker.internal:host-gateway");
		}

		const modelSettings = this.getRuntimeSettings().model;
		// Read the repository override fresh per launch so admin updates apply
		// without a restart. Refinement launches never consult it: refinements
		// always run on the global model.
		const repoBuildModel =
			repo && promptKind !== "issue-refinement"
				? this.options.resolveRepoBuildModel?.(repo.owner, repo.repo)?.trim() || undefined
				: undefined;
		const launchProvider = resolveLaunchProvider(modelSettings.piAgentProvider, repoBuildModel);
		if (launchProvider) {
			args.push("-e", `PI_AGENT_PROVIDER=${launchProvider}`);
		}
		const launchModel = resolveLaunchModel(modelSettings, promptKind, repoBuildModel);
		if (launchModel) {
			args.push("-e", `PI_AGENT_MODEL=${launchModel}`);
		}
		const initScript = process.env.YOLO_WORKER_INIT_SCRIPT?.trim();
		if (initScript) {
			args.push("-e", `YOLO_WORKER_INIT_SCRIPT=${initScript}`);
		}
		const initSkip = process.env.YOLO_WORKER_INIT_SKIP?.trim();
		if (initSkip) {
			args.push("-e", `YOLO_WORKER_INIT_SKIP=${initSkip}`);
		}
		const initTimeout = process.env.YOLO_WORKER_INIT_TIMEOUT_SECONDS?.trim();
		if (initTimeout) {
			args.push("-e", `YOLO_WORKER_INIT_TIMEOUT_SECONDS=${initTimeout}`);
		}
		const ollamaHost = this.resolveWorkerOllamaHost();
		if (ollamaHost) {
			args.push("-e", `OLLAMA_HOST=${ollamaHost}`);
		}

		const openaiApiKey = this.resolveWorkerOpenAiApiKey();
		if (openaiApiKey) {
			args.push("-e", `OPENAI_API_KEY=${openaiApiKey}`);
		}

		args.push(
			"-e",
			"YOLO_SESSION_KEY",
			"-e",
			"YOLO_SESSION_WS_URL",
			"-e",
			"YOLO_SOUL_PATH",
			workerTemplate.image,
		);

		return args;
	}

	private buildMountSpec(source: string, target: string): string {
		return `type=${path.isAbsolute(source) ? "bind" : "volume"},src=${source},dst=${target}`;
	}

	async resolveWorkerWorkspaceMountSource(): Promise<string> {
		if (!this.resolvedWorkerWorkspaceMountSource) {
			this.resolvedWorkerWorkspaceMountSource = (async () => {
				const configuredSource = this.options.workerWorkspaceMountSource.trim();
				if (path.isAbsolute(configuredSource)) {
					return configuredSource;
				}

				const currentContainerRef = process.env.HOSTNAME?.trim();
				if (!currentContainerRef) {
					return configuredSource;
				}

				try {
					const { stdout } = await execFileText(
						"docker",
						["inspect", "--format", "{{json .Mounts}}", currentContainerRef],
						this.options.projectRoot,
					);
					const mounts = JSON.parse(stdout) as Array<{
						Destination?: string;
						Type?: string;
						Name?: string;
						Source?: string;
					}>;
					const workspaceMount = mounts.find((mount) => mount.Destination === this.options.workspacesDir);
					if (workspaceMount?.Type === "volume" && workspaceMount.Name?.trim()) {
						return workspaceMount.Name.trim();
					}
					if (workspaceMount?.Type === "bind" && workspaceMount.Source?.trim()) {
						return workspaceMount.Source.trim();
					}
				} catch {
					// Fall back to the configured source when self-inspection is unavailable.
				}

				return configuredSource;
			})();
		}

		return this.resolvedWorkerWorkspaceMountSource;
	}

	async createLaunchPlan(params: {
		sessionKey: string;
		workerSessionUrl: string;
		containerName: string;
		workerTemplate: WorkerTemplate;
		/** Prompt kind of the launching session; selects the forwarded model. */
		promptKind?: WorkerPromptKind;
		/** Repository of the launching session; selects the per-repo build model. */
		repo?: { owner: string; repo: string };
	}): Promise<DockerWorkerLaunchPlan> {
		return {
			containerName: params.containerName,
			args: await this.buildDockerRunArgs(params.containerName, params.workerTemplate, params.promptKind, params.repo),
			env: {
				...process.env,
				YOLO_SESSION_KEY: params.sessionKey,
				YOLO_SESSION_WS_URL: params.workerSessionUrl,
				YOLO_SOUL_PATH: this.options.soulPath,
				YOLO_WORKER_OLLAMA_HOST: this.resolveWorkerOllamaHost(),
			},
			cwd: this.options.projectRoot,
		};
	}

	launchContainer(plan: DockerWorkerLaunchPlan, sessionKey: string, workerTemplate: WorkerTemplate): DockerWorkerContainerHandle {
		recordSessionLog(sessionKey, {
			level: "info",
			message: `Launching worker container ${plan.containerName}`,
			details: {
				type: "worker_launch",
				image: workerTemplate.image,
				template: workerTemplate.id,
				containerName: plan.containerName,
			},
		});

		const docker = spawn("docker", plan.args, {
			cwd: plan.cwd,
			env: plan.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let dockerStdout = "";
		let dockerStderr = "";
		docker.stdout?.on("data", (chunk: Buffer) => {
			dockerStdout = appendOutput(dockerStdout, chunk.toString("utf8"));
		});
		docker.stderr?.on("data", (chunk: Buffer) => {
			dockerStderr = appendOutput(dockerStderr, chunk.toString("utf8"));
		});

		let settled = false;
		const markSettled = () => {
			settled = true;
		};

		const getOutputTail = () => [dockerStderr.trim(), dockerStdout.trim()].filter(Boolean).join("\n");

		const dockerExitPromise = new Promise<never>((_resolve, reject) => {
			docker.on("error", (error) => reject(error));
			docker.on("exit", (code, signal) => {
				if (settled) {
					return;
				}
				const tail = getOutputTail();
				reject(
					new Error(
						[
							`Worker container exited before completion (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
							tail,
						]
							.filter(Boolean)
							.join("\n"),
					),
				);
			});
		});

		return {
			containerName: plan.containerName,
			docker,
			dockerExitPromise,
			markSettled,
			getOutputTail,
		};
	}

	private isContainerNameConflict(error: Error): boolean {
		return (
			error.message.includes("Conflict. The container name") &&
			error.message.includes("is already in use by container")
		);
	}

	async removeStoppedConflictingContainer(containerName: string, sessionKey: string): Promise<boolean> {
		let status: string;
		try {
			const result = await execFileText(
				"docker",
				["inspect", "--format", "{{.State.Status}}", containerName],
				this.options.projectRoot,
			);
			status = result.stdout.trim().toLowerCase();
		} catch (error) {
			recordSessionLog(sessionKey, {
				level: "error",
				message: `Could not inspect conflicting worker container ${containerName}`,
				details: {
					type: "worker_launch_recovery",
					containerName,
					error: error instanceof Error ? error.message : String(error),
				},
			});
			return false;
		}

		if (!STOPPED_CONTAINER_STATES.has(status)) {
			recordSessionLog(sessionKey, {
				level: "error",
				message: `Conflicting worker container ${containerName} is ${status || "in an unknown state"}; refusing to remove it`,
				details: { type: "worker_launch_recovery", containerName, status },
			});
			return false;
		}

		try {
			await execFileText("docker", ["rm", containerName], this.options.projectRoot);
			recordSessionLog(sessionKey, {
				level: "warn",
				message: `Removed stopped conflicting worker container ${containerName}; retrying launch`,
				details: { type: "worker_launch_recovery", containerName, status },
			});
			return true;
		} catch (error) {
			recordSessionLog(sessionKey, {
				level: "error",
				message: `Could not remove stopped conflicting worker container ${containerName}`,
				details: {
					type: "worker_launch_recovery",
					containerName,
					status,
					error: error instanceof Error ? error.message : String(error),
				},
			});
			return false;
		}
	}

	async runWithNameConflictRetry<T>(containerName: string, sessionKey: string, runAttempt: () => Promise<T>): Promise<T> {
		for (let retryCount = 0; ; retryCount += 1) {
			try {
				return await runAttempt();
			} catch (error) {
				const launchError = error instanceof Error ? error : new Error(String(error));
				if (!this.isContainerNameConflict(launchError)) {
					throw launchError;
				}

				if (retryCount >= MAX_WORKER_LAUNCH_RETRIES) {
					throw new Error(
						`Worker container launch failed after ${retryCount + 1} attempts (${MAX_WORKER_LAUNCH_RETRIES} retries).\n${launchError.message}`,
						{ cause: launchError },
					);
				}
				const recovered = await this.removeStoppedConflictingContainer(containerName, sessionKey);
				if (!recovered) {
					throw launchError;
				}
			}
		}
	}
}
