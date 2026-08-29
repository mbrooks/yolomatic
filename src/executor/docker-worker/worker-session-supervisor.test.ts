import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkerMessage, WORKER_PROTOCOL_VERSION, type AnyWorkerProtocolMessage, type WorkerProtocolMessage } from "../../worker/protocol.js";
import type { PendingWorkerRpcConnection, WorkerRpcConnection, WorkerRpcServer } from "../../worker/rpc-server.js";
import type { SessionState } from "../../session/store.js";
import type { ExecutionResult, RefinementResult } from "../results.js";

const { execFileMock, recordSessionLogMock } = vi.hoisted(() => ({
	execFileMock: vi.fn(),
	recordSessionLogMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFile: execFileMock,
}));

vi.mock("../../logging/session-log-store.js", () => ({
	recordSessionLog: recordSessionLogMock,
}));

import { WorkerSessionSupervisor } from "./worker-session-supervisor.js";

class FakeWorkerRpcConnection implements WorkerRpcConnection {
	private readonly messageListeners = new Set<(message: AnyWorkerProtocolMessage) => void>();
	private readonly closeListeners = new Set<() => void>();
	private readonly errorListeners = new Set<(error: Error) => void>();
	private readonly bufferedMessages: AnyWorkerProtocolMessage[] = [];
	private open = true;
	peer?: FakeWorkerRpcConnection;
	closeCode?: number;
	closeReason?: string;

	send(message: WorkerProtocolMessage): Promise<void> {
		return Promise.resolve().then(() => {
			if (!this.open || !this.peer?.open) {
				throw new Error("Worker RPC connection is not connected");
			}
			for (const listener of this.peer.messageListeners) {
				// Async worker-fake handlers may reject after the peer has since
				// closed; that must not surface as an unhandled rejection.
				void Promise.resolve(listener(message as AnyWorkerProtocolMessage)).catch(() => undefined);
			}
		});
	}

	onMessage(listener: (message: AnyWorkerProtocolMessage) => void): () => void {
		this.messageListeners.add(listener);
		for (const message of this.bufferedMessages.splice(0)) {
			listener(message);
		}
		return () => {
			this.messageListeners.delete(listener);
		};
	}

	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => {
			this.closeListeners.delete(listener);
		};
	}

	onError(listener: (error: Error) => void): () => void {
		this.errorListeners.add(listener);
		return () => {
			this.errorListeners.delete(listener);
		};
	}

	isOpen(): boolean {
		return this.open;
	}

	close(code?: number, reason?: string): void {
		this.closeCode = code;
		this.closeReason = reason;
		if (!this.open) return;
		this.open = false;
		queueMicrotask(() => {
			for (const listener of this.closeListeners) {
				listener();
			}
			if (this.peer?.open) {
				this.peer.open = false;
				this.peer.closeCode = code;
				this.peer.closeReason = reason;
				for (const listener of this.peer.closeListeners) {
					listener();
				}
			}
		});
	}

	emitError(error: Error): void {
		for (const listener of this.errorListeners) {
			listener(error);
		}
		// Transport errors are visible on both ends of a connection pair.
		if (this.peer) {
			for (const listener of this.peer.errorListeners) {
				listener(error);
			}
		}
	}
}

type FakePendingConnection = PendingWorkerRpcConnection & {
	sessionKey: string;
	serverConnection: FakeWorkerRpcConnection;
	workerConnection: FakeWorkerRpcConnection;
	resolveConnection: (connection: WorkerRpcConnection) => void;
	rejectConnection: (error: Error) => void;
	connected: boolean;
};

function createFakeWorkerRpcServer() {
	let tokenCounter = 0;
	const pendingConnections = new Map<string, FakePendingConnection>();

	return {
		createPendingConnection(sessionKey: string): PendingWorkerRpcConnection {
			const token = `token-${++tokenCounter}`;
			const serverConnection = new FakeWorkerRpcConnection();
			const workerConnection = new FakeWorkerRpcConnection();
			serverConnection.peer = workerConnection;
			workerConnection.peer = serverConnection;

			let resolveConnection!: (connection: WorkerRpcConnection) => void;
			let rejectConnection!: (error: Error) => void;
			const connectionPromise = new Promise<WorkerRpcConnection>((resolve, reject) => {
				resolveConnection = resolve;
				rejectConnection = reject;
			});

			const pending: FakePendingConnection = {
				token,
				sessionKey,
				serverConnection,
				workerConnection,
				resolveConnection,
				rejectConnection,
				connected: false,
				waitForConnection: () => connectionPromise,
				dispose: (error = new Error(`Worker RPC connection was not established for ${sessionKey}`)) => {
					pendingConnections.delete(token);
					if (!pending.connected) {
						rejectConnection(error);
					}
				},
			};

			pendingConnections.set(token, pending);
			return pending;
		},

		connectPending(token: string, sessionKey: string): FakeWorkerRpcConnection {
			const pending = pendingConnections.get(token);
			if (!pending || pending.sessionKey !== sessionKey) {
				throw new Error(`Unknown pending worker session ${sessionKey}`);
			}
			pendingConnections.delete(token);
			pending.connected = true;
			pending.resolveConnection(pending.serverConnection);
			return pending.workerConnection;
		},
	};
}

function connectWorkerSession(workerRpcServer: ReturnType<typeof createFakeWorkerRpcServer>, url: string): FakeWorkerRpcConnection {
	const parsedUrl = new URL(url);
	const token = parsedUrl.searchParams.get("token");
	const sessionKey = decodeURIComponent(parsedUrl.searchParams.get("sessionKey") ?? "");
	if (!token) {
		throw new Error("Missing worker RPC token");
	}
	return workerRpcServer.connectPending(token, sessionKey);
}

interface SupervisorHarness {
	workerRpcServer: ReturnType<typeof createFakeWorkerRpcServer>;
	supervisor: WorkerSessionSupervisor;
	capturedUrl: () => string | undefined;
	gateway: { handle: ReturnType<typeof vi.fn> };
	/** Handle for the fake launched container; emitting exit deterministically ends the session. */
	containerHandles: Array<{ docker: EventEmitter }>;
}

function createHarness(issueNumber: number, options: { withGateway?: boolean; outputTail?: string } = {}): SupervisorHarness {
	const workerRpcServer = createFakeWorkerRpcServer();
	let capturedUrl: string | undefined;
	const gateway = { handle: vi.fn() };
	const containerHandles: Array<{ docker: EventEmitter }> = [];

	const launcher = {
		createLaunchPlan: vi.fn(async ({ sessionKey, workerSessionUrl, containerName }: any) => ({
			containerName,
			args: [],
			env: {
				...process.env,
				YOLO_SESSION_KEY: sessionKey,
				YOLO_SESSION_WS_URL: workerSessionUrl,
			},
			cwd: "/repo",
		})),
		launchContainer: vi.fn((plan: any) => {
			capturedUrl = plan.env.YOLO_SESSION_WS_URL;
			let rejectExit!: (error: Error) => void;
			const handle = {
				containerName: plan.containerName,
				docker: new EventEmitter(),
				dockerExitPromise: new Promise<never>((_resolve, reject) => {
					rejectExit = reject;
				}),
				markSettled: () => undefined,
				getOutputTail: () => options.outputTail ?? "",
			};
			handle.docker.on("exit", (code: number | null, signal: string | null) => {
				const tail = options.outputTail ? `\n${options.outputTail}` : "";
				rejectExit(
					new Error(
						`Worker container exited before completion (code=${code ?? "null"}, signal=${signal ?? "null"}).${tail}`,
					),
				);
			});
			containerHandles.push(handle);
			return handle;
		}),
	};

	const supervisor = new WorkerSessionSupervisor({
		workerRpcServer: workerRpcServer as unknown as WorkerRpcServer,
		workerControlBaseUrl: "http://control-plane.test",
		launcher: launcher as any,
		...(options.withGateway ? { githubGateway: () => gateway as any } : {}),
	});

	return { workerRpcServer, supervisor, capturedUrl: () => capturedUrl, gateway, containerHandles };
}

function makeRunParams(issueNumber: number, kind: "issue" | "comment" | "pr-review" | "issue-refinement" = "issue") {
	const sessionKey = `github-mbrooks-yolomatic-issue-${issueNumber}-${kind === "issue-refinement" ? "issue-refinement" : "implementation"}`;
	return {
		sessionKey,
		params: {
			state: {
				issueNumber,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				...(kind === "issue-refinement" ? { kind } : {}),
				status: "pending",
				sessionPath: "/tmp/session.jsonl",
				workspacePath: "/workspaces/mbrooks/yolomatic",
				lastActivity: new Date().toISOString(),
				seeded: false,
			} as SessionState,
			prompt: { kind, text: "Prompt" },
			sessionKey,
			containerName: `yolomatic-session-mbrooks-yolomatic-${issueNumber}`,
			workspacePathInWorker: "/workspaces/mbrooks/yolomatic",
			workerTemplate: { id: "legacy", label: "Legacy", image: "worker:latest", dockerfile: "Dockerfile" },
		},
	};
}

/** Connects the fake worker and flushes one microtask round so launch/plan calls settle. */
async function connectWorker(harness: SupervisorHarness): Promise<FakeWorkerRpcConnection> {
	await Promise.resolve();
	const workerConnection = connectWorkerSession(harness.workerRpcServer, harness.capturedUrl() as string);
	await Promise.resolve();
	return workerConnection;
}

/** A worker that acks launch_config and then completes the session with `result`. */
function autoCompletingWorker(
	workerConnection: FakeWorkerRpcConnection,
	sessionKey: string,
	result: ExecutionResult | RefinementResult,
): void {
	workerConnection.onMessage(async (message) => {
		if (message.type === "launch_config") {
			await workerConnection.send(
				createWorkerMessage("ack", message.sessionKey, "ack-1", { ackMessageId: message.messageId }),
			);
			await workerConnection.send(
				createWorkerMessage("complete", sessionKey, "complete-1", { result }),
			);
		}
	});
}

/** Acknowledging worker: responds `ack` to every control/launch_config message. */
function ackingWorker(workerConnection: FakeWorkerRpcConnection): void {
	workerConnection.onMessage(async (message) => {
		if (message.type === "launch_config" || message.type === "control") {
			await workerConnection.send(
				createWorkerMessage("ack", message.sessionKey, "ack-1", { ackMessageId: message.messageId }),
			);
		}
	});
}

/** Worker that only acknowledges the initial launch_config, leaving later control messages unanswered. */
function launchConfigAckingWorker(workerConnection: FakeWorkerRpcConnection): void {
	workerConnection.onMessage((message) => {
		if (message.type === "launch_config") {
			void workerConnection.send(
				createWorkerMessage("ack", message.sessionKey, "ack-1", { ackMessageId: message.messageId }),
			);
		}
	});
}

function helloMessage(sessionKey: string, messageId = "hello-1"): WorkerProtocolMessage<"hello"> {
	return createWorkerMessage("hello", sessionKey, messageId, { workerVersion: "test", pid: 123 });
}

/** Ends the session deterministically by failing the fake launched container. */
function emitContainerExit(harness: SupervisorHarness, code: number | null = 137, signal: string | null = null): void {
	const handle = harness.containerHandles.at(-1);
	if (!handle) {
		throw new Error("No container was launched");
	}
	handle.docker.emit("exit", code, signal);
}

/** Worker that acks launch_config and completes only after a tool_response round-trip. */
function toolAwareCompletingWorker(
	workerConnection: FakeWorkerRpcConnection,
	result: ExecutionResult | RefinementResult,
): void {
	workerConnection.onMessage(async (message) => {
		if (message.type === "launch_config") {
			await workerConnection.send(
				createWorkerMessage("ack", message.sessionKey, "ack-1", { ackMessageId: message.messageId }),
			);
			return;
		}
		if (message.type === "tool_response") {
			await workerConnection.send(
				createWorkerMessage("complete", message.sessionKey, "complete-1", { result }),
			);
		}
	});
}

describe("WorkerSessionSupervisor", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("supervises a hello→launch_config→ack→complete transcript", async () => {
		const harness = createHarness(594);
		const { sessionKey, params } = makeRunParams(594);

		const sessionPromise = harness.supervisor.runSession(params);
		const workerConnection = await connectWorker(harness);

		expect(harness.capturedUrl()).toContain(`sessionKey=${sessionKey}`);
		expect(harness.capturedUrl()).toContain("token=token-1");

		autoCompletingWorker(workerConnection, sessionKey, { status: "complete", summary: "done", rawResponse: "YOLO_STATUS: complete\\ndone" });

		await workerConnection.send(createWorkerMessage("hello", sessionKey, "hello-1", { workerVersion: "test", pid: 123 }));

		const result = await sessionPromise;
		expect(result).toMatchObject({ status: "complete", summary: "done" });
	});

	it("sends a launch_config with session state, prompt, and runtime limits on hello", async () => {
		const harness = createHarness(594);
		const { sessionKey, params } = makeRunParams(594);
		const sessionPromise = harness.supervisor.runSession(params);

		const workerConnection = await connectWorker(harness);
		const received: AnyWorkerProtocolMessage[] = [];
		autoCompletingWorker(workerConnection, sessionKey, { status: "complete", summary: "done", rawResponse: "" });
		workerConnection.onMessage((message) => received.push(message));

		await workerConnection.send(createWorkerMessage("hello", sessionKey, "hello-1", { workerVersion: "test", pid: 123 }));
		await sessionPromise;

		const launchConfig = received.find((message) => message.type === "launch_config") as WorkerProtocolMessage<"launch_config">;
		expect(launchConfig).toBeDefined();
		expect(launchConfig.sessionKey).toBe(sessionKey);
		expect(launchConfig.payload.session).toMatchObject({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 594,
			kind: "implementation",
			workspacePath: "/workspaces/mbrooks/yolomatic",
			title: "Test",
			body: "Body",
		});
		expect(launchConfig.payload.prompt).toEqual({ kind: "issue", text: "Prompt" });
		expect(launchConfig.payload.limits).toEqual({ maxRuntimeSeconds: 7200 });
	});

	it("rejects messages that arrive with an unexpected session key", async () => {
		const harness = createHarness(595);
		const { params } = makeRunParams(595);

		const sessionPromise = harness.supervisor.runSession(params);
		const workerConnection = await connectWorker(harness);

		await workerConnection.send(
			createWorkerMessage("hello", "github-mbrooks-yolomatic-issue-999-implementation", "hello-wrong-session", {
				workerVersion: "test",
				pid: 321,
			}),
		);

		await expect(sessionPromise).rejects.toThrow("Worker connection closed unexpectedly.");
		expect(workerConnection.closeCode).toBe(1008);
		expect(workerConnection.closeReason).toContain("Unexpected session key github-mbrooks-yolomatic-issue-999-implementation");
	});

	it("closes when worker protocol version mismatches", async () => {
		const harness = createHarness(595);
		const { sessionKey, params } = makeRunParams(595);
		const sessionPromise = harness.supervisor.runSession(params);

		const workerConnection = await connectWorker(harness);
		await workerConnection.send({
			type: "hello",
			sessionKey,
			messageId: "hello-1",
			payload: { workerVersion: "test", pid: 123 },
			protocolVersion: WORKER_PROTOCOL_VERSION + 1,
		});

		await expect(sessionPromise).rejects.toThrow("Worker connection closed unexpectedly.");
		expect(workerConnection.closeCode).toBe(1002);
	});

	it("rejects the session when the worker reports an error without a stack", async () => {
		const harness = createHarness(596);
		const { sessionKey, params } = makeRunParams(596);

		const sessionPromise = harness.supervisor.runSession(params);
		const workerConnection = await connectWorker(harness);

		await workerConnection.send(createWorkerMessage("error", sessionKey, "error-1", { message: "worker blew up" }));

		await expect(sessionPromise).rejects.toThrow("worker blew up");
	});

	it("appends the stack to worker error rejections when present", async () => {
		const harness = createHarness(596);
		const { sessionKey, params } = makeRunParams(596);

		const sessionPromise = harness.supervisor.runSession(params);
		const workerConnection = await connectWorker(harness);

		await workerConnection.send(
			createWorkerMessage("error", sessionKey, "error-1", { message: "worker blew up", stack: "trace-line-1" }),
		);

		await expect(sessionPromise).rejects.toThrow("worker blew up\ntrace-line-1");
	});

	it("includes the docker output tail when the worker connection closes unexpectedly", async () => {
		const harness = createHarness(597, { outputTail: "docker: image not found" });
		const { sessionKey, params } = makeRunParams(597);

		const sessionPromise = harness.supervisor.runSession(params);
		const workerConnection = await connectWorker(harness);
		ackingWorker(workerConnection);
		await workerConnection.send(helloMessage(sessionKey));

		workerConnection.close();

		await expect(sessionPromise).rejects.toThrow(
			"Worker connection closed unexpectedly.\ndocker: image not found",
		);
	});

	it("exposes steer via onSessionCreated and resolves the steer on ack", async () => {
		const harness = createHarness(599);
		const { sessionKey, params } = makeRunParams(599);
		const onSessionCreated = vi.fn();

		const sessionPromise = harness.supervisor.runSession({ ...params, onSessionCreated });
		const workerConnection = await connectWorker(harness);
		const received: AnyWorkerProtocolMessage[] = [];
		workerConnection.onMessage((message) => received.push(message));
		ackingWorker(workerConnection);

		await workerConnection.send(helloMessage(sessionKey));
		await vi.waitFor(() => expect(onSessionCreated).toHaveBeenCalledTimes(1));

		const liveSession = onSessionCreated.mock.calls[0]![0];
		await expect(liveSession.steer("focus on tests")).resolves.toBeUndefined();

		const steerMessages = received.filter((message) => message.type === "control") as WorkerProtocolMessage<"control">[];
		expect(steerMessages).toHaveLength(1);
		expect(steerMessages[0]!.payload).toEqual({ action: "steer", message: "focus on tests" });

		await workerConnection.send(
			createWorkerMessage("complete", sessionKey, "complete-1", { result: { status: "complete", summary: "done", rawResponse: "" } }),
		);
		await expect(sessionPromise).resolves.toMatchObject({ status: "complete", summary: "done" });
	});

	it("fails a pending steer when the session ends before the ack", async () => {
		const harness = createHarness(606);
		const { sessionKey, params } = makeRunParams(606);
		const onSessionCreated = vi.fn();

		const sessionPromise = harness.supervisor.runSession({ ...params, onSessionCreated });
		const workerConnection = await connectWorker(harness);
		launchConfigAckingWorker(workerConnection);

		await workerConnection.send(helloMessage(sessionKey));
		await vi.waitFor(() => expect(onSessionCreated).toHaveBeenCalledTimes(1));

		const liveSession = onSessionCreated.mock.calls[0]![0];
		const steerPromise = liveSession.steer("do the thing").then(
			() => "resolved" as const,
			(error: Error) => `rejected: ${error.message}` as const,
		);

		// The session stays open (steer ack pending) until the container exits.
		emitContainerExit(harness);

		await expect(sessionPromise).rejects.toThrow("Worker container exited before completion");
		expect(await steerPromise).toBe("rejected: Worker session ended before acknowledgement");
	});

	it("sends a stop control on abort and falls back to docker stop after the grace period", async () => {
		vi.useFakeTimers();
		execFileMock.mockImplementation((_cmd: string, _args: string[], _options: unknown, callback?: (error: Error | null) => void) => {
			callback?.(null);
		});
		const harness = createHarness(600);
		const { sessionKey, params } = makeRunParams(600);
		const controller = new AbortController();
		const received: AnyWorkerProtocolMessage[] = [];

		const sessionPromise = harness.supervisor.runSession({ ...params, abortSignal: controller.signal });
		const workerConnection = await connectWorker(harness);
		workerConnection.onMessage((message) => received.push(message));
		ackingWorker(workerConnection);

		await workerConnection.send(helloMessage(sessionKey));
		controller.abort();
		await vi.advanceTimersByTimeAsync(10);

		const stopControls = received.filter((message) => message.type === "control") as WorkerProtocolMessage<"control">[];
		expect(stopControls).toHaveLength(1);
		expect(stopControls[0]!.payload).toEqual({ action: "stop" });
		expect(execFileMock).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(5100);
		expect(execFileMock).toHaveBeenCalledWith(
			"docker",
			["stop", params.containerName],
			expect.objectContaining({ cwd: "/repo" }),
			expect.any(Function),
		);

		await workerConnection.send(
			createWorkerMessage("complete", sessionKey, "complete-1", { result: { status: "complete", summary: "done", rawResponse: "" } }),
		);
		await expect(sessionPromise).resolves.toMatchObject({ status: "complete" });
	});

	it("dispatches tool_request through the gateway and answers ack plus tool_response", async () => {
		const harness = createHarness(602, { withGateway: true });
		const { sessionKey, params } = makeRunParams(602);

		const sessionPromise = harness.supervisor.runSession(params);
		const workerConnection = await connectWorker(harness);
		const received: AnyWorkerProtocolMessage[] = [];
		workerConnection.onMessage((message) => received.push(message));
		toolAwareCompletingWorker(workerConnection, { status: "complete", summary: "done", rawResponse: "" });
		harness.gateway.handle.mockResolvedValue({ ok: true, data: { title: "Refactor" } });

		await workerConnection.send(helloMessage(sessionKey));
		await workerConnection.send(
			createWorkerMessage("tool_request", sessionKey, "tool-1", { tool: "get_issue", params: { issueNumber: 602 } }),
		);

		await expect(sessionPromise).resolves.toMatchObject({ status: "complete" });

		expect(harness.gateway.handle).toHaveBeenCalledWith(params.state, { tool: "get_issue", params: { issueNumber: 602 } });
		const acks = received.filter((message) => message.type === "ack") as WorkerProtocolMessage<"ack">[];
		expect(acks.map((message) => message.payload.ackMessageId)).toContain("tool-1");
		const toolResponse = received.find((message) => message.type === "tool_response") as WorkerProtocolMessage<"tool_response">;
		expect(toolResponse.payload).toEqual({ requestMessageId: "tool-1", ok: true, data: { title: "Refactor" } });
		expect(recordSessionLogMock).toHaveBeenCalledWith(
			sessionKey,
			expect.objectContaining({ level: "tool", message: "gateway get_issue done" }),
		);
	});

	it("returns a failed tool_response when the gateway handler rejects", async () => {
		const harness = createHarness(609, { withGateway: true });
		const { sessionKey, params } = makeRunParams(609);

		const sessionPromise = harness.supervisor.runSession(params);
		const workerConnection = await connectWorker(harness);
		const received: AnyWorkerProtocolMessage[] = [];
		workerConnection.onMessage((message) => received.push(message));
		toolAwareCompletingWorker(workerConnection, { status: "complete", summary: "done", rawResponse: "" });
		harness.gateway.handle.mockRejectedValue(new Error("github unreachable"));

		await workerConnection.send(helloMessage(sessionKey));
		await workerConnection.send(
			createWorkerMessage("tool_request", sessionKey, "tool-1", { tool: "list_issues", params: {} }),
		);

		await expect(sessionPromise).resolves.toMatchObject({ status: "complete" });

		const toolResponse = received.find((message) => message.type === "tool_response") as WorkerProtocolMessage<"tool_response">;
		expect(toolResponse.payload).toEqual({ requestMessageId: "tool-1", ok: false, error: "github unreachable" });
		expect(recordSessionLogMock).toHaveBeenCalledWith(
			sessionKey,
			expect.objectContaining({ level: "error", message: "gateway list_issues failed" }),
		);
	});

	it("answers tool_request with an error when no gateway is configured", async () => {
		const harness = createHarness(607);
		const { sessionKey, params } = makeRunParams(607);

		const sessionPromise = harness.supervisor.runSession(params);
		const workerConnection = await connectWorker(harness);
		const received: AnyWorkerProtocolMessage[] = [];
		workerConnection.onMessage((message) => received.push(message));
		toolAwareCompletingWorker(workerConnection, { status: "complete", summary: "done", rawResponse: "" });

		await workerConnection.send(helloMessage(sessionKey));
		await workerConnection.send(
			createWorkerMessage("tool_request", sessionKey, "tool-1", { tool: "get_issue", params: { issueNumber: 1 } }),
		);

		await expect(sessionPromise).resolves.toMatchObject({ status: "complete" });
		expect(harness.gateway.handle).not.toHaveBeenCalled();

		const toolResponse = received.find((message) => message.type === "tool_response") as WorkerProtocolMessage<"tool_response">;
		expect(toolResponse.payload).toEqual({
			requestMessageId: "tool-1",
			ok: false,
			error: "GitHub gateway is not enabled for this control plane",
		});
	});

	it("parses a valid refinement completion for issue-refinement prompts", async () => {
		const harness = createHarness(608);
		const { sessionKey, params } = makeRunParams(608, "issue-refinement");

		const sessionPromise = harness.supervisor.runSession(params);
		const workerConnection = await connectWorker(harness);
		autoCompletingWorker(workerConnection, sessionKey, {
			proposedTaskBody: "## Proposed Task\nDo it.",
			summary: "Refined summary",
			investigation: "Read the code.",
		});

		await workerConnection.send(helloMessage(sessionKey));

		await expect(sessionPromise).resolves.toMatchObject({
			proposedTaskBody: "## Proposed Task\nDo it.",
			summary: "Refined summary",
			investigation: "Read the code.",
		});
	});

	it("rejects with an invalid refinement result when refinement completion fails validation", async () => {
		const harness = createHarness(610);
		const { sessionKey, params } = makeRunParams(610, "issue-refinement");

		const sessionPromise = harness.supervisor.runSession(params);
		const workerConnection = await connectWorker(harness);
		autoCompletingWorker(workerConnection, sessionKey, { proposedTaskBody: "", summary: "", investigation: "" });

		await workerConnection.send(helloMessage(sessionKey));

		await expect(sessionPromise).rejects.toThrow("Worker returned an invalid refinement result.");
	});

	it("rejects the session when the connection raises an error event", async () => {
		const harness = createHarness(611);
		const { sessionKey, params } = makeRunParams(611);

		const sessionPromise = harness.supervisor.runSession(params);
		const workerConnection = await connectWorker(harness);
		ackingWorker(workerConnection);

		await workerConnection.send(helloMessage(sessionKey));
		await vi.waitFor(() => expect(sessionPromise).toBeDefined());

		const connectionError = new Error("socket failed");
		workerConnection.emitError(connectionError);

		await expect(sessionPromise).rejects.toBe(connectionError);
	});

	it("ignores unknown message types without settling the session", async () => {
		const harness = createHarness(612);
		const { sessionKey, params } = makeRunParams(612);

		const sessionPromise = harness.supervisor.runSession(params);
		const workerConnection = await connectWorker(harness);
		ackingWorker(workerConnection);

		await workerConnection.send(helloMessage(sessionKey));
		workerConnection.send({
			type: "teleport_request",
			sessionKey,
			messageId: "mystery-1",
			payload: { answer: 42 },
			protocolVersion: WORKER_PROTOCOL_VERSION,
		} as unknown as WorkerProtocolMessage);

		await workerConnection.send(
			createWorkerMessage("complete", sessionKey, "complete-1", { result: { status: "complete", summary: "done", rawResponse: "" } }),
		);
		await expect(sessionPromise).resolves.toMatchObject({ status: "complete" });
	});

	it("persists session_log events and ignores other event types in event batches", async () => {
		const harness = createHarness(603);
		const { sessionKey, params } = makeRunParams(603);
		const activity = vi.fn();

		const sessionPromise = harness.supervisor.runSession({ ...params, onActivity: activity });
		const workerConnection = await connectWorker(harness);
		autoCompletingWorker(workerConnection, sessionKey, { status: "complete", summary: "done", rawResponse: "" });

		// Open the session first so the batch arrives on a live connection.
		await workerConnection.send(helloMessage(sessionKey));
		await workerConnection.send({
			type: "event_batch",
			sessionKey,
			messageId: "batch-1",
			payload: {
				events: [
					{ type: "session_log", entry: { level: "warn", message: "taskfile changed", details: { path: "/p" } } },
					{ type: "tool_activity", payload: { tool: "read" } },
				],
			} as any,
			protocolVersion: WORKER_PROTOCOL_VERSION,
		} as any);

		await sessionPromise;

		expect(recordSessionLogMock).toHaveBeenCalledWith(sessionKey, {
			level: "warn",
			message: "taskfile changed",
			details: { path: "/p" },
		});
		expect(activity).toHaveBeenCalled();
	});
});