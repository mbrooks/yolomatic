import { describe, expect, it, vi } from "vitest";

const wsTestHarness = vi.hoisted(() => {
	class TinyEmitter {
		private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

		on(event: string, listener: (...args: any[]) => void): this {
			const listeners = this.listeners.get(event) ?? new Set();
			listeners.add(listener);
			this.listeners.set(event, listeners);
			return this;
		}

		once(event: string, listener: (...args: any[]) => void): this {
			const wrapped = (...args: any[]) => {
				this.off(event, wrapped);
				listener(...args);
			};
			return this.on(event, wrapped);
		}

		off(event: string, listener: (...args: any[]) => void): this {
			this.listeners.get(event)?.delete(listener);
			return this;
		}

		emit(event: string, ...args: unknown[]): boolean {
			const listeners = this.listeners.get(event);
			if (!listeners || listeners.size === 0) return false;
			for (const listener of [...listeners]) {
				listener(...args);
			}
			return true;
		}
	}

	class FakeWebSocket extends TinyEmitter {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;

		readyState = FakeWebSocket.CONNECTING;
		peer?: FakeWebSocket;

		link(peer: FakeWebSocket): void {
			this.peer = peer;
			peer.peer = this;
		}

		open(): void {
			if (this.readyState !== FakeWebSocket.CONNECTING) return;
			this.readyState = FakeWebSocket.OPEN;
			this.emit("open");
		}

		send(data: string | Buffer, callback?: (error?: Error) => void): void {
			queueMicrotask(() => {
				if (this.readyState !== FakeWebSocket.OPEN || !this.peer || this.peer.readyState !== FakeWebSocket.OPEN) {
					callback?.(new Error("socket is not open"));
					return;
				}
				const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
				this.peer.emit("message", payload);
				callback?.();
			});
		}

		close(code = 1000, reason?: string): void {
			if (this.readyState === FakeWebSocket.CLOSED) return;
			this.readyState = FakeWebSocket.CLOSING;
			const peer = this.peer;
			queueMicrotask(() => {
				this.readyState = FakeWebSocket.CLOSED;
				this.emit("close", code, Buffer.from(reason ?? "", "utf8"));
				if (peer && peer.readyState !== FakeWebSocket.CLOSED) {
					peer.readyState = FakeWebSocket.CLOSED;
					peer.emit("close", code, Buffer.from(reason ?? "", "utf8"));
				}
			});
		}

		terminate(): void {
			this.close(1006, "terminated");
		}
	}

	class FakeWebSocketServer extends TinyEmitter {
		handleUpgrade(
			request: { url?: string },
			socket: { ws: FakeWebSocket },
			_head: Buffer,
			callback: (ws: FakeWebSocket, request: { url?: string }) => void,
		): void {
			callback(socket.ws, request);
			this.emit("connection", socket.ws, request);
			socket.ws.open();
		}

		close(callback?: () => void): void {
			callback?.();
		}
	}

	return {
		FakeWebSocket,
		FakeWebSocketServer,
	};
});

vi.mock("ws", () => ({
	default: wsTestHarness.FakeWebSocket,
	WebSocket: wsTestHarness.FakeWebSocket,
	WebSocketServer: wsTestHarness.FakeWebSocketServer,
}));

import { createWorkerMessage } from "./protocol.js";
import { WorkerRpcServer, WORKER_RPC_PATH } from "./rpc-server.js";
import { decodeWorkerWebSocketMessage, sendWorkerWebSocketMessage } from "./websocket-transport.js";

describe("WorkerRpcServer", () => {
	it("accepts a pending worker session and buffers early messages", async () => {
		const { server, rpcServer, close } = createHarness();
		const pending = rpcServer.createPendingConnection("mbrooks/yeetomatic#77");
		const { client, socket } = createUpgradeSocket();

		server.emit(
			"upgrade",
			{ url: `${WORKER_RPC_PATH}?sessionKey=mbrooks%2Fyeetomatic%2377&token=${pending.token}` },
			socket,
			Buffer.alloc(0),
		);

		await sendWorkerWebSocketMessage(
			client as never,
			createWorkerMessage("hello", "mbrooks/yeetomatic#77", "msg-1", { workerVersion: "test", pid: 1 }),
		);

		try {
			const connection = await pending.waitForConnection();
			const seenMessages: string[] = [];
			connection.onMessage((message) => {
				seenMessages.push(message.messageId);
			});

			expect(seenMessages).toEqual(["msg-1"]);

			const clientMessages: string[] = [];
			client.on("message", (raw: Buffer) => {
				clientMessages.push(decodeWorkerWebSocketMessage(raw).messageId);
			});

			await connection.send(createWorkerMessage("ack", "mbrooks/yeetomatic#77", "ack-1", { ackMessageId: "msg-1" }));
			await waitFor(() => expect(clientMessages).toEqual(["ack-1"]));

			client.close();
			await waitFor(() => expect(connection.isOpen()).toBe(false));
		} finally {
			await close();
		}
	});

	it("rejects unauthorized upgrade attempts", async () => {
		const { server, rpcServer, close } = createHarness();
		const pending = rpcServer.createPendingConnection("mbrooks/yeetomatic#78");
		void pending.waitForConnection().catch(() => undefined);
		const { socket } = createUpgradeSocket();

		try {
			server.emit(
				"upgrade",
				{ url: `${WORKER_RPC_PATH}?sessionKey=mbrooks%2Fyeetomatic%2378&token=wrong` },
				socket,
				Buffer.alloc(0),
			);

			expect(socket.write).toHaveBeenCalledWith("HTTP/1.1 401 Unauthorized\r\n\r\n");
			expect(socket.destroy).toHaveBeenCalled();
		} finally {
			pending.dispose();
			await close();
		}
	});

	it("rejects pending connections when disposed or closed", async () => {
		const { rpcServer, close } = createHarness();
		try {
			const disposed = rpcServer.createPendingConnection("mbrooks/yeetomatic#79");
			disposed.dispose(new Error("disposed"));
			await expect(disposed.waitForConnection()).rejects.toThrow("disposed");

			const closed = rpcServer.createPendingConnection("mbrooks/yeetomatic#80");
			await rpcServer.close();
			await expect(closed.waitForConnection()).rejects.toThrow("closed before mbrooks/yeetomatic#80 connected");
		} finally {
			await close();
		}
	});

	it("buffers websocket errors and reports closed connections immediately", async () => {
		const { server, rpcServer, close } = createHarness();
		const pending = rpcServer.createPendingConnection("mbrooks/yeetomatic#81");
		const { client, socket } = createUpgradeSocket();

		server.emit(
			"upgrade",
			{ url: `${WORKER_RPC_PATH}?sessionKey=mbrooks%2Fyeetomatic%2381&token=${pending.token}` },
			socket,
			Buffer.alloc(0),
		);

		try {
			const connection = await pending.waitForConnection();
			client.send("not json");

			const seenErrors: string[] = [];
			connection.onError((error) => {
				seenErrors.push(error.message);
			});
			await waitFor(() => expect(seenErrors[0]).toContain("Unexpected token"));
			client.send("still not json");
			await waitFor(() => expect(seenErrors).toHaveLength(2));

			client.close();
			await waitFor(() => expect(connection.isOpen()).toBe(false));

			const onClose = vi.fn();
			connection.onClose(onClose);
			expect(onClose).toHaveBeenCalledTimes(1);
		} finally {
			await close();
		}
	});

	it("ignores unrelated upgrade requests and closes safely before attach", async () => {
		const unattachedServer = new WorkerRpcServer();
		await expect(unattachedServer.close()).resolves.toBeUndefined();

		const { server, rpcServer, close } = createHarness();
		const pending = rpcServer.createPendingConnection("mbrooks/yeetomatic#82");
		void pending.waitForConnection().catch(() => undefined);
		const { socket } = createUpgradeSocket();

		try {
			server.emit(
				"upgrade",
				{ url: "/not-worker" },
				socket,
				Buffer.alloc(0),
			);

			expect(socket.write).not.toHaveBeenCalled();
			expect(socket.destroy).not.toHaveBeenCalled();
		} finally {
			pending.dispose();
			await close();
		}
	});

	it("closes active connections and ignores dispose after a worker is connected", async () => {
		const { server, rpcServer, close } = createHarness();
		const pending = rpcServer.createPendingConnection("mbrooks/yeetomatic#83");
		const { client, socket } = createUpgradeSocket();

		server.emit(
			"upgrade",
			{ url: `${WORKER_RPC_PATH}?sessionKey=mbrooks%2Fyeetomatic%2383&token=${pending.token}` },
			socket,
			Buffer.alloc(0),
		);

		const connection = await pending.waitForConnection();
		pending.dispose();

		try {
			await rpcServer.close();
			await waitFor(() => expect(connection.isOpen()).toBe(false));
		} finally {
			await close();
			client.close();
		}
	});

	it("ignores missing upgrade URLs, rejects mismatched sessions, and supports unsubscribing error listeners", async () => {
		const { server, rpcServer, close } = createHarness();
		const ignored = createUpgradeSocket();
		server.emit("upgrade", {}, ignored.socket, Buffer.alloc(0));
		expect(ignored.socket.write).not.toHaveBeenCalled();
		expect(ignored.socket.destroy).not.toHaveBeenCalled();

		const mismatched = rpcServer.createPendingConnection("mbrooks/yeetomatic#84");
		void mismatched.waitForConnection().catch(() => undefined);
		const mismatchSocket = createUpgradeSocket();
		server.emit(
			"upgrade",
			{ url: `${WORKER_RPC_PATH}?sessionKey=mbrooks%2Fyeetomatic%23999&token=${mismatched.token}` },
			mismatchSocket.socket,
			Buffer.alloc(0),
		);
		expect(mismatchSocket.socket.write).toHaveBeenCalledWith("HTTP/1.1 401 Unauthorized\r\n\r\n");
		expect(mismatchSocket.socket.destroy).toHaveBeenCalled();

		const pending = rpcServer.createPendingConnection("mbrooks/yeetomatic#85");
		const { client, socket } = createUpgradeSocket();
		server.emit(
			"upgrade",
			{ url: `${WORKER_RPC_PATH}?sessionKey=mbrooks%2Fyeetomatic%2385&token=${pending.token}` },
			socket,
			Buffer.alloc(0),
		);

		try {
			const connection = await pending.waitForConnection();
			const onError = vi.fn();
			const unsubscribe = connection.onError(onError);
			unsubscribe();

			client.send("broken json");
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(onError).not.toHaveBeenCalled();
		} finally {
			mismatched.dispose();
			client.close();
			await close();
		}
	});
});

function createHarness(): {
	server: {
		on(event: string, listener: (...args: any[]) => void): unknown;
		emit(event: string, ...args: any[]): boolean;
	};
	rpcServer: WorkerRpcServer;
	close: () => Promise<void>;
} {
	class TinyEmitter {
		private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

		on(event: string, listener: (...args: any[]) => void): this {
			const listeners = this.listeners.get(event) ?? new Set();
			listeners.add(listener);
			this.listeners.set(event, listeners);
			return this;
		}

		emit(event: string, ...args: any[]): boolean {
			const listeners = this.listeners.get(event);
			if (!listeners || listeners.size === 0) return false;
			for (const listener of [...listeners]) {
				listener(...args);
			}
			return true;
		}
	}

	const server = new TinyEmitter();
	const rpcServer = new WorkerRpcServer();
	rpcServer.attach(server as never);
	return {
		server,
		rpcServer,
		close: () => rpcServer.close(),
	};
}

function createUpgradeSocket(): {
	client: InstanceType<typeof wsTestHarness.FakeWebSocket>;
	serverSocket: InstanceType<typeof wsTestHarness.FakeWebSocket>;
	socket: { ws: InstanceType<typeof wsTestHarness.FakeWebSocket>; write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
} {
	const client = new wsTestHarness.FakeWebSocket();
	const server = new wsTestHarness.FakeWebSocket();
	client.link(server);
	server.open();
	client.open();

	return {
		client,
		serverSocket: server,
		socket: {
			ws: server,
			write: vi.fn(),
			destroy: vi.fn(),
		},
	};
}

async function waitFor(assertion: () => void, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			assertion();
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	assertion();
}
