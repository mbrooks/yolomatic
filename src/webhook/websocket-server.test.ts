import { beforeEach, describe, expect, it, vi } from "vitest";

type MessageHandler = (raw: Buffer | ArrayBuffer | Buffer[]) => void;
type UpgradeHandler = (request: { url?: string; headers?: Record<string, string> }, socket: FakeUpgradeSocket, head: Buffer) => void;

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

class FakeUpgradeSocket {
	writes: string[] = [];
	destroyed = false;

	write(payload: string): void {
		this.writes.push(payload);
	}

	destroy(): void {
		this.destroyed = true;
	}
}

class FakeHttpServer {
	upgradeHandler: UpgradeHandler | null = null;

	on(event: "upgrade", handler: UpgradeHandler): void {
		if (event === "upgrade") {
			this.upgradeHandler = handler;
		}
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

	handleUpgrade(
		_request: unknown,
		_socket: unknown,
		_head: Buffer,
		callback: (ws: FakeSocket) => void,
	): void {
		const ws = new FakeSocket();
		this.clients.add(ws);
		callback(ws);
	}

	emit(event: "connection", ws: FakeSocket): void {
		if (event === "connection") {
			connectionHandler?.(ws);
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

	it("registers a path-scoped noServer websocket listener", async () => {
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		const httpServer = new FakeHttpServer();
		createAdminWebSocketServer(httpServer as never, { getCredentials: () => ({}) });

		expect(capturedOptions).toEqual({ noServer: true });
		expect(httpServer.upgradeHandler).toBeTypeOf("function");
	});

	it("allows onboarding and authorized admin upgrades while rejecting invalid auth", async () => {
		const { createAdminWebSocketServer } = await import("./websocket-server.js");

		const onboardingServer = new FakeHttpServer();
		createAdminWebSocketServer(onboardingServer as never, { getCredentials: () => ({}) });
		const onboardingSocket = new FakeUpgradeSocket();
		onboardingServer.upgradeHandler?.({ url: "/yeetomatic/admin/ws", headers: {} }, onboardingSocket, Buffer.alloc(0));
		expect(onboardingSocket.writes).toEqual([]);
		expect(onboardingSocket.destroyed).toBe(false);

		const protectedServer = new FakeHttpServer();
		createAdminWebSocketServer(protectedServer as never, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		});

		const rejectedSocket = new FakeUpgradeSocket();
		protectedServer.upgradeHandler?.({ url: "/yeetomatic/admin/ws", headers: {} }, rejectedSocket, Buffer.alloc(0));
		expect(rejectedSocket.writes).toEqual(["HTTP/1.1 401 Unauthorized\r\n\r\n"]);
		expect(rejectedSocket.destroyed).toBe(true);

		const acceptedSocket = new FakeUpgradeSocket();
		protectedServer.upgradeHandler?.(
			{
				url: "/yeetomatic/admin/ws",
				headers: {
					authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
				},
			},
			acceptedSocket,
			Buffer.alloc(0),
		);
		expect(acceptedSocket.writes).toEqual([]);
		expect(acceptedSocket.destroyed).toBe(false);
	});

	it("uses a custom configured admin path for the websocket upgrade", async () => {
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		const httpServer = new FakeHttpServer();
		createAdminWebSocketServer(
			httpServer as never,
			{ getCredentials: () => ({}) },
			undefined,
			undefined,
			"/custom/admin",
		);

		const matchingSocket = new FakeUpgradeSocket();
		httpServer.upgradeHandler?.({ url: "/custom/admin/ws", headers: {} }, matchingSocket, Buffer.alloc(0));
		expect(matchingSocket.writes).toEqual([]);
		expect(matchingSocket.destroyed).toBe(false);

		const legacySocket = new FakeUpgradeSocket();
		httpServer.upgradeHandler?.({ url: "/yeetomatic/admin/ws", headers: {} }, legacySocket, Buffer.alloc(0));
		expect(legacySocket.writes).toEqual([]);
		expect(legacySocket.destroyed).toBe(false);
	});

	it("ignores upgrade requests for other websocket paths", async () => {
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		const httpServer = new FakeHttpServer();
		createAdminWebSocketServer(httpServer as never, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		});

		const socket = new FakeUpgradeSocket();
		httpServer.upgradeHandler?.({ url: "/yeetomatic-worker/ws?token=abc", headers: {} }, socket, Buffer.alloc(0));
		expect(socket.writes).toEqual([]);
		expect(socket.destroyed).toBe(false);
	});

	it("broadcasts subscribed logs and status updates", async () => {
		const statusProvider = { getStatus: vi.fn(async () => ({ agent: "online" })) };
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		const server = createAdminWebSocketServer(
			new FakeHttpServer() as never,
			{ getCredentials: () => ({ username: "admin", password: "secret" }) },
			statusProvider,
		);
		const socket = new FakeSocket();
		(connectionHandler as (ws: FakeSocket) => void)(socket);

		socket.emitMessage({ type: "subscribe-log", owner: "mbrooks", repo: "yeetomatic", issueNumber: 1 });
		socket.emitMessage({ type: "subscribe-status" });
		await Promise.resolve();

		server.broadcastLog("mbrooks/yeetomatic#1", {
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
					sessionKey: "mbrooks/yeetomatic#1",
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

	it("stops sending log entries after unsubscribe", async () => {
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		const server = createAdminWebSocketServer(new FakeHttpServer() as never, { getCredentials: () => ({}) });
		const socket = new FakeSocket();
		(connectionHandler as (ws: FakeSocket) => void)(socket);

		socket.emitMessage({ type: "subscribe-log", owner: "mbrooks", repo: "yeetomatic", issueNumber: 1 });
		socket.emitMessage({ type: "unsubscribe-log", owner: "mbrooks", repo: "yeetomatic", issueNumber: 1 });
		server.broadcastLog("mbrooks/yeetomatic#1", {
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
		createAdminWebSocketServer(new FakeHttpServer() as never, { getCredentials: () => ({}) }, statusProvider);
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
		createAdminWebSocketServer(new FakeHttpServer() as never, { getCredentials: () => ({}) });
		const socket = new FakeSocket();
		(connectionHandler as (ws: FakeSocket) => void)(socket);

		socket.emitMessage({ type: "subscribe-status" });
		await Promise.resolve();

		expect(socket.sent).toEqual([]);
	});

	it("ignores invalid websocket payloads", async () => {
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		createAdminWebSocketServer(new FakeHttpServer() as never, { getCredentials: () => ({}) });
		const socket = new FakeSocket();
		(connectionHandler as (ws: FakeSocket) => void)(socket);

		socket.emitRawMessage("not json");
		expect(socket.sent).toEqual([]);
	});

	it("terminates clients on close", async () => {
		const { createAdminWebSocketServer } = await import("./websocket-server.js");
		const server = createAdminWebSocketServer(new FakeHttpServer() as never, { getCredentials: () => ({}) });
		const socket = new FakeSocket();
		(connectionHandler as (ws: FakeSocket) => void)(socket);
		lastWebSocketServer?.clients.add(socket);

		await expect(server.close()).resolves.toBeUndefined();
		expect(socket.terminated).toBe(true);
		expect(closeSpy).toHaveBeenCalled();
	});
});
