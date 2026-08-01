import { access } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { ExecutionResult } from "./results.js";
import { buildFeedbackPrompt, buildIssuePrompt, buildPRReviewPrompt, type PRReviewComment } from "./prompts.js";
import { recordSessionLog } from "../logging/session-log-store.js";
import { sessionKey as buildSessionKey } from "../domain/session/model.js";
import type { ExecutionService, LiveExecutionSession } from "../ports/execution-service.js";
import type { SessionState } from "../session/store.js";
import {
	WORKER_PROTOCOL_VERSION,
	createWorkerMessage,
	type AnyWorkerProtocolMessage,
	type WorkerAckPayload,
	type WorkerCompletePayload,
	type WorkerErrorPayload,
	type WorkerControlPayload,
	type WorkerEventBatchPayload,
	type WorkerProtocolMessage,
} from "../worker/protocol.js";
import { WORKER_RPC_PATH, type WorkerRpcConnection, type WorkerRpcServer } from "../worker/rpc-server.js";

const execFileAsync = promisify(execFile);
const WORKER_IMAGE_TRANSPORT_LABEL = "io.yeetomatic.worker.transport";
const WORKER_IMAGE_TRANSPORT_VERSION = "websocket-v1";
const MAX_WORKER_LAUNCH_RETRIES = 3;
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

export interface DockerWorkerExecutorOptions {
	projectRoot: string;
	workspacesDir: string;
	workerImage: string;
	workerWorkspaceMountSource: string;
	workerControlBaseUrl: string;
	workerDockerNetworkMode?: string;
	workerRpcServer: WorkerRpcServer;
	workerOllamaHost?: string;
	soulPath: string;
}

export class DockerWorkerExecutor implements ExecutionService {
	private imageReady?: Promise<void>;
	private resolvedWorkerWorkspaceMountSource?: Promise<string>;

	constructor(private readonly options: DockerWorkerExecutorOptions) {}

	execute(
		state: SessionState,
		comment?: string,
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: LiveExecutionSession) => void,
		onActivity?: () => void,
	): Promise<ExecutionResult> {
		const prompt = comment ? buildFeedbackPrompt(comment) : buildIssuePrompt(state);
		return this.runWorker(state, { kind: comment ? "comment" : "issue", text: prompt }, abortSignal, onSessionCreated, onActivity);
	}

	executePRReview(
		state: SessionState,
		prReview: { comments: PRReviewComment[]; reviewBody?: string },
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: LiveExecutionSession) => void,
		onActivity?: () => void,
	): Promise<ExecutionResult> {
		const prompt = buildPRReviewPrompt(state, prReview.comments, prReview.reviewBody);
		return this.runWorker(state, { kind: "pr-review", text: prompt }, abortSignal, onSessionCreated, onActivity);
	}

	private async runWorker(
		state: SessionState,
		prompt: { kind: "issue" | "comment" | "pr-review"; text: string },
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: LiveExecutionSession) => void,
		onActivity?: () => void,
	): Promise<ExecutionResult> {
		await this.ensureWorkerImage();

		const sessionKey = buildSessionKey(state.owner, state.repo, state.issueNumber);
		const containerName = this.buildContainerName(state);
		const workspacePathInWorker = this.resolveWorkerWorkspacePath(state.workspacePath);
		await this.validateLaunch(state.workspacePath);

		for (let retryCount = 0; ; retryCount += 1) {
			try {
				return await this.runWorkerAttempt(
					state,
					prompt,
					sessionKey,
					containerName,
					workspacePathInWorker,
					abortSignal,
					onSessionCreated,
					onActivity,
				);
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

	private async runWorkerAttempt(
		state: SessionState,
		prompt: { kind: "issue" | "comment" | "pr-review"; text: string },
		sessionKey: string,
		containerName: string,
		workspacePathInWorker: string,
		abortSignal?: AbortSignal,
		onSessionCreated?: (session: LiveExecutionSession) => void,
		onActivity?: () => void,
	): Promise<ExecutionResult> {
		const pendingConnection = this.options.workerRpcServer.createPendingConnection(sessionKey);
		const workerSessionUrl = this.buildWorkerSessionUrl(sessionKey, pendingConnection.token);

		recordSessionLog(sessionKey, {
			level: "info",
			message: `Launching worker container ${containerName}`,
			details: { type: "worker_launch", image: this.options.workerImage, containerName },
		});

		let connection: WorkerRpcConnection | undefined;
		let dockerStdout = "";
		let dockerStderr = "";
		let settled = false;
		let abortTimer: NodeJS.Timeout | undefined;
		const pendingAcks = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
		const nextMessageId = this.createMessageIdFactory();

		const cleanupPendingAcks = (error: Error) => {
			for (const pending of pendingAcks.values()) {
				pending.reject(error);
			}
			pendingAcks.clear();
		};

		const sendMessage = (message: WorkerProtocolMessage, expectAck = false): Promise<void> => {
			if (!connection?.isOpen()) {
				return Promise.reject(new Error("Worker RPC connection is not connected"));
			}

			const sendPromise = connection.send(message);
			if (!expectAck) {
				return sendPromise;
			}

			return new Promise<void>((resolve, reject) => {
				pendingAcks.set(message.messageId, { resolve, reject });
				void sendPromise.catch((error) => {
					pendingAcks.delete(message.messageId);
					reject(error instanceof Error ? error : new Error(String(error)));
				});
			});
		};

		const sendControl = async (payload: WorkerControlPayload): Promise<void> => {
			const message = createWorkerMessage("control", sessionKey, nextMessageId(), payload);
			await sendMessage(message, true);
		};

		let executionResolve!: (result: ExecutionResult) => void;
		let executionReject!: (error: Error) => void;
		const executionPromise = new Promise<ExecutionResult>((resolve, reject) => {
			executionResolve = resolve;
			executionReject = reject;
		});

		const docker = spawn("docker", await this.buildDockerRunArgs(containerName), {
			cwd: this.options.projectRoot,
			env: {
				...process.env,
				YEETOMATIC_SESSION_KEY: sessionKey,
				YEETOMATIC_SESSION_WS_URL: workerSessionUrl,
				YEETOMATIC_SOUL_PATH: this.options.soulPath,
				YEETOMATIC_WORKER_OLLAMA_HOST: this.resolveWorkerOllamaHost(),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		docker.stdout.on("data", (chunk: Buffer) => {
			dockerStdout = this.appendOutput(dockerStdout, chunk.toString("utf8"));
		});
		docker.stderr.on("data", (chunk: Buffer) => {
			dockerStderr = this.appendOutput(dockerStderr, chunk.toString("utf8"));
		});

		const dockerExitPromise = new Promise<never>((_resolve, reject) => {
			docker.on("error", (error) => reject(error));
			docker.on("exit", (code, signal) => {
				if (settled) {
					return;
				}
				const tail = [dockerStderr.trim(), dockerStdout.trim()].filter(Boolean).join("\n");
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

		const requestStop = async (): Promise<void> => {
			if (settled) return;
			try {
				await sendControl({ action: "stop" });
			} catch {
				// Fall through to docker stop below.
			}
			abortTimer = setTimeout(() => {
				void execFileAsync("docker", ["stop", containerName], { cwd: this.options.projectRoot }).catch(() => undefined);
			}, 5000);
			abortTimer.unref?.();
		};

		const onAbort = () => {
			void requestStop();
		};
		abortSignal?.addEventListener("abort", onAbort);

		try {
			connection = await Promise.race([pendingConnection.waitForConnection(), dockerExitPromise]);
			connection.onMessage((message) => {
				if (message.protocolVersion !== WORKER_PROTOCOL_VERSION) {
					connection?.close(1002, `Unsupported worker protocol version ${message.protocolVersion}`);
					return;
				}
				if (message.sessionKey !== sessionKey) {
					connection?.close(1008, `Unexpected session key ${message.sessionKey}`);
					return;
				}
				void this.handleWorkerMessage(
					message,
					state,
					prompt,
					sessionKey,
					workspacePathInWorker,
					sendMessage,
					nextMessageId,
					pendingAcks,
					onSessionCreated,
					onActivity,
					(result) => {
						settled = true;
						executionResolve(result);
					},
					(error) => {
						settled = true;
						executionReject(error);
					},
				).catch((error) => {
					settled = true;
					executionReject(error instanceof Error ? error : new Error(String(error)));
				});
			});
			connection.onClose(() => {
				connection = undefined;
				if (!settled) {
					const details = [dockerStderr.trim(), dockerStdout.trim()].filter(Boolean).join("\n");
					executionReject(new Error(details ? `Worker connection closed unexpectedly.\n${details}` : "Worker connection closed unexpectedly."));
				}
			});
			connection.onError((error) => {
				if (!settled) {
					executionReject(error);
				}
			});

			return await Promise.race([executionPromise, dockerExitPromise]);
		} finally {
			abortSignal?.removeEventListener("abort", onAbort);
			if (abortTimer) {
				clearTimeout(abortTimer);
			}
			cleanupPendingAcks(new Error("Worker session ended before acknowledgement"));
			connection?.close();
			pendingConnection.dispose();
		}
	}

	private isContainerNameConflict(error: Error): boolean {
		return error.message.includes("Conflict. The container name") && error.message.includes("is already in use by container");
	}

	private async removeStoppedConflictingContainer(containerName: string, sessionKey: string): Promise<boolean> {
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

	private async handleWorkerMessage(
		message: AnyWorkerProtocolMessage,
		state: SessionState,
		prompt: { kind: "issue" | "comment" | "pr-review"; text: string },
		sessionKey: string,
		workspacePathInWorker: string,
		sendMessage: (message: WorkerProtocolMessage, expectAck?: boolean) => Promise<void>,
		nextMessageId: () => string,
		pendingAcks: Map<string, { resolve: () => void; reject: (error: Error) => void }>,
		onSessionCreated: ((session: LiveExecutionSession) => void) | undefined,
		onActivity: (() => void) | undefined,
		onComplete: (result: ExecutionResult) => void,
		onError: (error: Error) => void,
	): Promise<void> {
		switch (message.type) {
			case "hello": {
				const launchConfig = createWorkerMessage("launch_config", sessionKey, nextMessageId(), {
					session: {
						owner: state.owner,
						repo: state.repo,
						issueNumber: state.issueNumber,
						workspacePath: workspacePathInWorker,
						title: state.title,
						body: state.body,
						sessionTag: state.sessionTag,
					},
					prompt,
					limits: { maxRuntimeSeconds: 7200 },
				});
				await sendMessage(launchConfig, true);
				onSessionCreated?.({
					steer: async (content: string) => {
						await sendMessage(
							createWorkerMessage("control", sessionKey, nextMessageId(), { action: "steer", message: content }),
							true,
						);
					},
				});
				return;
			}

			case "ack": {
				const payload = message.payload as WorkerAckPayload;
				const pending = pendingAcks.get(payload.ackMessageId);
				if (pending) {
					pendingAcks.delete(payload.ackMessageId);
					pending.resolve();
				}
				return;
			}

			case "event_batch": {
				this.persistWorkerEvents(sessionKey, message.payload as WorkerEventBatchPayload, onActivity);
				return;
			}

			case "heartbeat": {
				onActivity?.();
				return;
			}

			case "complete": {
				onComplete((message.payload as WorkerCompletePayload).result);
				return;
			}

			case "error": {
				const payload = message.payload as WorkerErrorPayload;
				onError(new Error(payload.stack ? `${payload.message}\n${payload.stack}` : payload.message));
				return;
			}

			default: {
				return;
			}
		}
	}

	private persistWorkerEvents(sessionKey: string, payload: WorkerEventBatchPayload, onActivity?: () => void): void {
		for (const event of payload.events) {
			if (event.type !== "session_log") continue;
			recordSessionLog(sessionKey, {
				level: event.entry.level,
				message: event.entry.message,
				details: event.entry.details,
			});
			onActivity?.();
		}
	}

	private async buildDockerRunArgs(containerName: string): Promise<string[]> {
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

		if (process.env.PI_AGENT_PROVIDER?.trim()) {
			args.push("-e", `PI_AGENT_PROVIDER=${process.env.PI_AGENT_PROVIDER.trim()}`);
		}
		if (process.env.PI_AGENT_MODEL?.trim()) {
			args.push("-e", `PI_AGENT_MODEL=${process.env.PI_AGENT_MODEL.trim()}`);
		}
		const ollamaHost = this.resolveWorkerOllamaHost();
		if (ollamaHost) {
			args.push("-e", `OLLAMA_HOST=${ollamaHost}`);
		}

		args.push(
			"-e",
			"YEETOMATIC_SESSION_KEY",
			"-e",
			"YEETOMATIC_SESSION_WS_URL",
			"-e",
			"YEETOMATIC_SOUL_PATH",
			this.options.workerImage,
		);

		return args;
	}

	private buildMountSpec(source: string, target: string): string {
		return `type=${path.isAbsolute(source) ? "bind" : "volume"},src=${source},dst=${target}`;
	}

	private async resolveWorkerWorkspaceMountSource(): Promise<string> {
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

	private buildWorkerSessionUrl(sessionKey: string, token: string): string {
		const url = new URL(this.options.workerControlBaseUrl);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.pathname = WORKER_RPC_PATH;
		url.search = "";
		url.searchParams.set("sessionKey", sessionKey);
		url.searchParams.set("token", token);
		return url.toString();
	}

	private resolveWorkerWorkspacePath(workspacePath: string): string {
		const relative = path.relative(this.options.workspacesDir, workspacePath);
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(`Workspace path ${workspacePath} is outside configured WORKSPACES_DIR ${this.options.workspacesDir}`);
		}
		return path.posix.join(this.getWorkerWorkspacesDir(), ...relative.split(path.sep));
	}

	private getWorkerWorkspacesDir(): string {
		return this.options.workspacesDir.split(path.sep).join(path.posix.sep);
	}

	private async validateLaunch(workspacePath: string): Promise<void> {
		await access(workspacePath);
		await this.assertWorkspaceRemoteIsSanitized(workspacePath);
	}

	/**
	 * Refuse to launch a worker whose mounted workspace still exposes a
	 * credential-bearing remote.origin.url. The control plane is responsible
	 * for sanitizing the remote before the worker starts; a token here would
	 * let the credential-free worker push directly.
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

	private resolveWorkerOllamaHost(): string | undefined {
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

	private async ensureWorkerImage(): Promise<void> {
		if (!this.imageReady) {
			// Rebuild once per control-plane process so deployments cannot reuse a
			// worker image built from older source. Docker caches unchanged layers.
			this.imageReady = execFileAsync(
				"docker",
				[
					"build",
					"--target",
					"worker",
					"--label",
					`${WORKER_IMAGE_TRANSPORT_LABEL}=${WORKER_IMAGE_TRANSPORT_VERSION}`,
					"-t",
					this.options.workerImage,
					this.options.projectRoot,
				],
				{
					cwd: this.options.projectRoot,
				},
			).then(() => undefined);
		}

		await this.imageReady;
	}

	private buildContainerName(state: SessionState): string {
		return `yeetomatic-session-${state.owner}-${state.repo}-${state.issueNumber}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
	}

	private createMessageIdFactory(): () => string {
		let counter = 0;
		return () => `msg-${++counter}`;
	}

	private appendOutput(current: string, chunk: string): string {
		const combined = `${current}${chunk}`;
		return combined.length > 4000 ? combined.slice(combined.length - 4000) : combined;
	}
}
