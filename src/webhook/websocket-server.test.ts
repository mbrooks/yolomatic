import { beforeEach, describe, expect, it, vi } from "vitest";

type MessageHandler = (raw: Buffer | ArrayBuffer | Buffer[]) => void;

class FakeSocket {
	static OPEN = 1;

	readyState = FakeSocket.OPEN;
	sent: string[] = [];
	terminated = false;
	private messageHandler: MessageHandler | null = null;
	private closeHandler: (() => void) | null = null;
	private errorHandler: (() => void) | null = null;

	on(event: "message" | "close" | "error", handler: (() => void) | MessageHandler): void {
		if (event === "message") {
			this.messageHandler = handler as MessageHandler;
		} else if (event === "close") {
			this.closeHandler = handler as () => void;
		} else if (event === "error") {
			this.errorHandler = handler as () => void;
		}
	}

	send(payload: string): void {
		this.sent.push(payload);
	}

	terminate(): void {
		this.terminated = true;
	}

	emitMessage(payload: unknown): void {
		this.messageHandler?.(Buffer.from(JSON.stringify(payload)));
	}

	emitRawMessage(payload: string): void {
		this.messageHandler?.(Buffer.from(payload));
	}

	emitClose(): void {
		this.closeHandler?.();
	}

	emitError(): void {
		this.errorHandler?.();
	}
}

let capturedOptions: any;
let connectionHandler: ((ws: FakeSocket) => void) | null = null;
const closeSpy = vi.fn((callback: () => void) => callback());
let lastWebSocketServer: FakeWebSocketServer | null = null;

class FakeWebSocketServer {
	clients = new Set<FakeSocket>();

	constructor(options: unknown) {
		capturedOptions = options;
		lastWebSocketServer = this;
	}

	on(event: "connection", handler: (ws: FakeSocket) => void): void {
		if (event === "connection") {
			connectionHandler = handler;
		}
	}

	close(callback: () => void): void {
		closeSpy(callback);
	}
}

vi.mock("ws", () => ({
	WebSocketServer: FakeWebSocketServer,
	WebSocket: { OPEN: FakeSocket.OPEN },
}));

describe("createAdminWebSocketServer", () => {
	beforeEach(() => {
		capturedOptions = undefined;
		connectionHandler = null;
		closeSpy.mockClear();
		lastWebSocketServer = null;
		vi.useRealTimers();
	});

	it("validates onboarding and basic-auth websocket connections", async () => {
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		createAdminWebSocketServer({} as never, { getCredentials: () => ({}) });

		const allow = vi.fn();
		capturedOptions.verifyClient({ req: { headers: {} } }, allow);
		expect(allow).toHaveBeenCalledWith(true);

		createAdminWebSocketServer({} as never, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		});

		const reject = vi.fn();
		capturedOptions.verifyClient({ req: { headers: {} } }, reject);
		expect(reject).toHaveBeenCalledWith(false, 401, "Unauthorized");

		const accept = vi.fn();
		capturedOptions.verifyClient(
			{
				req: {
					headers: {
						authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
					},
				},
			},
			accept,
		);
		expect(accept).toHaveBeenCalledWith(true);

		const mismatch = vi.fn();
		capturedOptions.verifyClient(
			{
				req: {
					headers: {
						authorization: `Basic ${Buffer.from("admin:wrong").toString("base64")}`,
					},
				},
			},
			mismatch,
		);
		expect(mismatch).toHaveBeenCalledWith(false, 401, "Unauthorized");
	});

	it("broadcasts subscribed logs and status updates", async () => {
		const statusProvider = { getStatus: vi.fn(async () => ({ agent: "online" })) };
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		const server = createAdminWebSocketServer(
			{} as never,
			{ getCredentials: () => ({ username: "admin", password: "secret" }) },
			statusProvider,
		);
		const socket = new FakeSocket();
		(connectionHandler as (ws: FakeSocket) => void)(socket);

		socket.emitMessage({ type: "subscribe-log", owner: "mbrooks", repo: "tars", issueNumber: 1 });
		socket.emitMessage({ type: "subscribe-status" });
		await Promise.resolve();

		server.broadcastLog("mbrooks/tars#1", {
			timestamp: "2025-01-01T00:00:00Z",
			level: "info",
			message: "hello",
		});
		server.broadcastStatus({ agent: "busy" });

		expect(socket.sent.map((entry) => JSON.parse(entry))).toEqual(
			expect.arrayContaining([
				{ type: "status", data: { agent: "online" } },
				{
					type: "log-entry",
					sessionKey: "mbrooks/tars#1",
					entry: {
						timestamp: "2025-01-01T00:00:00Z",
						level: "info",
						message: "hello",
					},
				},
				{ type: "status", data: { agent: "busy" } },
			]),
		);
	});

	it("streams issue chat progress and responses", async () => {
		const issueChatProvider = {
			runIssueChat: vi.fn(async (_requestId, _payload, onProgress) => {
				onProgress({ type: "started", message: "Thinking..." });
				return {
					message: "Created",
					owner: "mbrooks",
					repo: "tars",
					draft: { title: "Bug", body: "Body", labels: [], assignees: [] },
					readyToCreate: true,
					shouldCreate: true,
				};
			}),
		};
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		createAdminWebSocketServer(
			{} as never,
			{ getCredentials: () => ({}) },
			undefined,
			issueChatProvider,
		);
		const socket = new FakeSocket();
		(connectionHandler as (ws: FakeSocket) => void)(socket);

		socket.emitMessage({
			type: "issue-chat",
			requestId: "req-1",
			payload: { messages: [{ role: "user", text: "hello" }] },
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(issueChatProvider.runIssueChat).toHaveBeenCalledWith(
			"req-1",
			{ messages: [{ role: "user", text: "hello" }] },
			expect.any(Function),
		);
		expect(socket.sent.map((entry) => JSON.parse(entry))).toEqual(
			expect.arrayContaining([
				{
					type: "issue-chat-progress",
					requestId: "req-1",
					event: { type: "started", message: "Thinking..." },
				},
				{
					type: "issue-chat-response",
					requestId: "req-1",
					response: {
						message: "Created",
						owner: "mbrooks",
						repo: "tars",
						draft: { title: "Bug", body: "Body", labels: [], assignees: [] },
						readyToCreate: true,
						shouldCreate: true,
					},
				},
			]),
		);
	});

	it("reports issue chat configuration errors and request failures", async () => {
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		createAdminWebSocketServer({} as never, { getCredentials: () => ({}) });
		const socket = new FakeSocket();
		(connectionHandler as (ws: FakeSocket) => void)(socket);

		socket.emitMessage({
			type: "issue-chat",
			requestId: "req-missing",
			payload: { messages: [{ role: "user", text: "hello" }] },
		});

		expect(socket.sent.map((entry) => JSON.parse(entry))).toContainEqual({
			type: "error",
			message: "Issue chat is not configured",
		});

		const failingProvider = {
			runIssueChat: vi.fn(async () => {
				throw new Error("boom");
			}),
		};
		createAdminWebSocketServer({} as never, { getCredentials: () => ({}) }, undefined, failingProvider);
		const failingSocket = new FakeSocket();
		(connectionHandler as (ws: FakeSocket) => void)(failingSocket);
		failingSocket.emitMessage({
			type: "issue-chat",
			requestId: "req-error",
			payload: { messages: [{ role: "user", text: "hello" }] },
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(failingSocket.sent.map((entry) => JSON.parse(entry))).toContainEqual({
			type: "issue-chat-progress",
			requestId: "req-error",
			event: { type: "error", message: "boom" },
		});
	});

	it("cancels active issue chat via task control service", async () => {
		const taskControlService = {
			cancel: vi.fn(),
			steer: vi.fn(),
			isActive: vi.fn(),
			register: vi.fn(),
			unregister: vi.fn(),
			isDraining: vi.fn(),
			setDraining: vi.fn(),
		};
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		createAdminWebSocketServer(
			{} as never,
			{ getCredentials: () => ({}) },
			undefined,
			undefined,
			taskControlService,
		);
		const socket = new FakeSocket();
		(connectionHandler as (ws: FakeSocket) => void)(socket);

		socket.emitMessage({
			type: "issue-chat-abort",
			requestId: "req-abort-1",
		});
		await Promise.resolve();

		expect(taskControlService.cancel).toHaveBeenCalledWith("req-abort-1");
	});

	it("steers active issue chat via task control service", async () => {
		const taskControlService = {
			cancel: vi.fn(),
			steer: vi.fn(),
			isActive: vi.fn(),
			register: vi.fn(),
			unregister: vi.fn(),
			isDraining: vi.fn(),
			setDraining: vi.fn(),
		};
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		createAdminWebSocketServer(
			{} as never,
			{ getCredentials: () => ({}) },
			undefined,
			undefined,
			taskControlService,
		);
		const socket = new FakeSocket();
		(connectionHandler as (ws: FakeSocket) => void)(socket);

		socket.emitMessage({
			type: "issue-chat-steer",
			requestId: "req-steer-1",
			message: "focus on performance",
		});
		await Promise.resolve();

		expect(taskControlService.steer).toHaveBeenCalledWith("req-steer-1", "focus on performance");
	});

	it("stops sending log entries after unsubscribe", async () => {
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		const server = createAdminWebSocketServer({} as never, { getCredentials: () => ({}) });
		const socket = new FakeSocket();
		(connectionHandler as (ws: FakeSocket) => void)(socket);

		socket.emitMessage({ type: "subscribe-log", owner: "mbrooks", repo: "tars", issueNumber: 1 });
		socket.emitMessage({ type: "unsubscribe-log", owner: "mbrooks", repo: "tars", issueNumber: 1 });
		server.broadcastLog("mbrooks/tars#1", {
			timestamp: "2025-01-01T00:00:00Z",
			level: "info",
			message: "hidden",
		});

		expect(socket.sent.map((entry) => JSON.parse(entry))).not.toContainEqual(
			expect.objectContaining({
				type: "log-entry",
			}),
		);
	});

	it("polls status while subscribed and stops on close and error", async () => {
		vi.useFakeTimers();
		const statusProvider = { getStatus: vi.fn(async () => ({ agent: "online" })) };
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		createAdminWebSocketServer({} as never, { getCredentials: () => ({}) }, statusProvider);
		const socket = new FakeSocket();
		(connectionHandler as (ws: FakeSocket) => void)(socket);

		socket.emitMessage({ type: "subscribe-status" });
		await Promise.resolve();
		statusProvider.getStatus.mockClear();

		await vi.advanceTimersByTimeAsync(5000);
		expect(statusProvider.getStatus).toHaveBeenCalledTimes(1);

		socket.emitClose();
		statusProvider.getStatus.mockClear();
		await vi.advanceTimersByTimeAsync(5000);
		expect(statusProvider.getStatus).not.toHaveBeenCalled();

		const anotherSocket = new FakeSocket();
		(connectionHandler as (ws: FakeSocket) => void)(anotherSocket);
		anotherSocket.emitMessage({ type: "subscribe-status" });
		await Promise.resolve();
		statusProvider.getStatus.mockClear();

		anotherSocket.emitError();
		await vi.advanceTimersByTimeAsync(5000);
		expect(statusProvider.getStatus).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	it("skips initial status delivery when no provider exists", async () => {
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		createAdminWebSocketServer({} as never, { getCredentials: () => ({}) });
		const socket = new FakeSocket();
		(connectionHandler as (ws: FakeSocket) => void)(socket);

		socket.emitMessage({ type: "subscribe-status" });
		await Promise.resolve();

		expect(socket.sent).toEqual([]);
	});

	it("does not send issue chat updates when the socket has closed", async () => {
		const issueChatProvider = {
			runIssueChat: vi.fn(async (_requestId, _payload, onProgress) => {
				onProgress({ type: "started", message: "Thinking..." });
				return {
					message: "Created",
					owner: "mbrooks",
					repo: "tars",
					draft: { title: "Bug", body: "Body", labels: [], assignees: [] },
					readyToCreate: true,
					shouldCreate: true,
				};
			}),
		};
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		createAdminWebSocketServer({} as never, { getCredentials: () => ({}) }, undefined, issueChatProvider);
		const socket = new FakeSocket();
		socket.readyState = 0;
		(connectionHandler as (ws: FakeSocket) => void)(socket);

		socket.emitMessage({
			type: "issue-chat",
			requestId: "req-closed",
			payload: { messages: [{ role: "user", text: "hello" }] },
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(socket.sent).toEqual([]);
	});

	it("ignores invalid websocket payloads", async () => {
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		createAdminWebSocketServer({} as never, { getCredentials: () => ({}) });
		const socket = new FakeSocket();
		(connectionHandler as (ws: FakeSocket) => void)(socket);

		socket.emitRawMessage("not json");
		expect(socket.sent).toEqual([]);
	});

	it("terminates clients on close", async () => {
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		const server = createAdminWebSocketServer({} as never, { getCredentials: () => ({}) });
		const socket = new FakeSocket();
		(connectionHandler as (ws: FakeSocket) => void)(socket);
		lastWebSocketServer?.clients.add(socket);

		await expect(server.close()).resolves.toBeUndefined();
		expect(socket.terminated).toBe(true);
		expect(closeSpy).toHaveBeenCalled();
	});
});
