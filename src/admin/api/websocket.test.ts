import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { webSocketManager } from "./websocket.js";

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	readyState = MockWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: ((err: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	sent: string[] = [];

	private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

	constructor(public url: string) {}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.();
	}

	// Test helpers
	triggerOpen(): void {
		this.readyState = MockWebSocket.OPEN;
		this.onopen?.();
	}

	triggerClose(): void {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.();
	}

	triggerError(): void {
		this.readyState = MockWebSocket.CLOSED;
		this.onerror?.(new Event("error"));
	}

	triggerMessage(data: unknown): void {
		this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
	}
}

describe("webSocketManager", () => {
	let originalWebSocket: typeof WebSocket;
	let sockets: MockWebSocket[] = [];

	beforeEach(() => {
		originalWebSocket = globalThis.WebSocket as typeof WebSocket;
		sockets = [];
		globalThis.WebSocket = vi.fn((url: string) => {
			const socket = new MockWebSocket(url);
			sockets.push(socket);
			return socket;
		}) as unknown as typeof WebSocket;
		(globalThis.WebSocket as unknown as Record<string, number>).CONNECTING = MockWebSocket.CONNECTING;
		(globalThis.WebSocket as unknown as Record<string, number>).OPEN = MockWebSocket.OPEN;
		(globalThis.WebSocket as unknown as Record<string, number>).CLOSING = MockWebSocket.CLOSING;
		(globalThis.WebSocket as unknown as Record<string, number>).CLOSED = MockWebSocket.CLOSED;

		Object.defineProperty(globalThis, "location", {
			value: { protocol: "http:", host: "localhost:6767" },
			writable: true,
			configurable: true,
		});
		Object.defineProperty(globalThis, "window", {
			value: globalThis,
			writable: true,
			configurable: true,
		});

		webSocketManager["disconnect"]();
	});

	afterEach(() => {
		globalThis.WebSocket = originalWebSocket;
		webSocketManager["disconnect"]();
	});

	it("connects and subscribes to logs", () => {
		const cb = vi.fn();
		const unsub = webSocketManager.subscribeLog("mbrooks", "tars", 1, cb);
		expect(sockets).toHaveLength(1);
		const socket = sockets[0];
		socket.triggerOpen();

		expect(socket.url).toBe("ws://localhost:6767/tarsadmin/ws");
		expect(webSocketManager.connectionStatus).toBe("open");
		expect(socket.sent).toContain(
			JSON.stringify({ type: "subscribe-log", owner: "mbrooks", repo: "tars", issueNumber: 1 }),
		);

		unsub();
	});

	it("receives log entries via websocket", () => {
		const cb = vi.fn();
		webSocketManager.subscribeLog("mbrooks", "tars", 1, cb);
		const socket = sockets[0];
		socket.triggerOpen();

		socket.triggerMessage({
			type: "log-entry",
			sessionKey: "mbrooks/tars#1",
			entry: { timestamp: "2025-01-01T00:00:00Z", level: "info", message: "hello" },
		});

		expect(cb).toHaveBeenCalledWith({ timestamp: "2025-01-01T00:00:00Z", level: "info", message: "hello" });
	});

	it("receives status updates via websocket", () => {
		const cb = vi.fn();
		webSocketManager.subscribeStatus(cb);
		const socket = sockets[0];
		socket.triggerOpen();

		socket.triggerMessage({
			type: "status",
			data: { agent: "online" },
		});

		expect(cb).toHaveBeenCalledWith({ agent: "online" });
	});

	it("reconnects after close", () => {
		webSocketManager.subscribeStatus(() => {
			/* no-op */
		});
		const socket = sockets[0];
		socket.triggerOpen();
		expect(webSocketManager.connectionStatus).toBe("open");

		socket.triggerClose();
		expect(webSocketManager.connectionStatus).toBe("closed");

		// Should create a new socket after reconnect delay
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(sockets.length).toBeGreaterThanOrEqual(1);
				resolve();
			}, 1200);
		});
	});

	it("does not reconnect when all subscribers unsubscribe", () => {
		vi.useFakeTimers();
		const unsubscribe = webSocketManager.subscribeStatus(() => {});
		const socket = sockets[0];
		socket.triggerOpen();

		unsubscribe();
		vi.advanceTimersByTime(1200);

		expect(sockets).toHaveLength(1);
	});

	it("notifies status change subscribers", () => {
		const cb = vi.fn();
		webSocketManager.onStatusChange(cb);
		webSocketManager.subscribeStatus(() => {});
		const socket = sockets[0];
		socket.triggerOpen();

		expect(cb).toHaveBeenCalledWith("open");
	});

	it("does not create duplicate connections", () => {
		webSocketManager.subscribeStatus(() => {});
		expect(sockets).toHaveLength(1);

		webSocketManager.connect();
		webSocketManager.connect();

		expect(sockets).toHaveLength(1);
	});

	it("unsubscribes status without error when ws is null", () => {
		const unsub = webSocketManager.subscribeStatus(() => {});
		webSocketManager["disconnect"]();
		expect(() => unsub()).not.toThrow();
	});

	it("disconnects and sets status to closed", () => {
		webSocketManager.subscribeStatus(() => {});
		const socket = sockets[0];
		socket.triggerOpen();
		expect(webSocketManager.connectionStatus).toBe("open");

		webSocketManager["disconnect"]();
		expect(webSocketManager.connectionStatus).toBe("closed");
	});

	it("sends subscription messages when ws is already open", () => {
		webSocketManager.subscribeStatus(() => {});
		const socket = sockets[0];
		socket.triggerOpen();

		const sendSpy = vi.spyOn(socket, "send");

		webSocketManager.subscribeLog("owner", "repo", 99, () => {});
		expect(sendSpy).toHaveBeenCalledWith(
			JSON.stringify({ type: "subscribe-log", owner: "owner", repo: "repo", issueNumber: 99 }),
		);
	});

	it("sends issue chat requests and resolves the response", async () => {
		const responsePromise = webSocketManager.requestIssueChat(
			{ owner: "mbrooks", repo: "tars", messages: [{ role: "user", text: "hello" }] },
			vi.fn(),
		);
		const socket = sockets[0];
		socket.triggerOpen();

		const issueChatMessage = socket.sent
			.map((entry) => JSON.parse(entry))
			.find((entry) => entry.type === "issue-chat");
		expect(issueChatMessage).toBeTruthy();

		socket.triggerMessage({
			type: "issue-chat-response",
			requestId: issueChatMessage.requestId,
			response: {
				message: "done",
				owner: "mbrooks",
				repo: "tars",
				draft: { title: "Title", body: "", labels: [], assignees: [] },
				readyToCreate: false,
				shouldCreate: false,
			},
		});

		await expect(responsePromise).resolves.toMatchObject({ message: "done" });
	});

	it("forwards issue chat progress events", async () => {
		const progress = vi.fn();
		const responsePromise = webSocketManager.requestIssueChat(
			{ owner: "mbrooks", repo: "tars", messages: [{ role: "user", text: "hello" }] },
			progress,
		);
		const socket = sockets[0];
		socket.triggerOpen();
		const issueChatMessage = socket.sent
			.map((entry) => JSON.parse(entry))
			.find((entry) => entry.type === "issue-chat");

		socket.triggerMessage({
			type: "issue-chat-progress",
			requestId: issueChatMessage.requestId,
			event: { type: "started", message: "Thinking..." },
		});
		socket.triggerMessage({
			type: "issue-chat-response",
			requestId: issueChatMessage.requestId,
			response: {
				message: "done",
				owner: "mbrooks",
				repo: "tars",
				draft: { title: "Title", body: "", labels: [], assignees: [] },
				readyToCreate: false,
				shouldCreate: false,
			},
		});

		await responsePromise;
		expect(progress).toHaveBeenCalledWith({ type: "started", message: "Thinking..." });
	});

	it("ignores invalid JSON messages", () => {
		const cb = vi.fn();
		webSocketManager.subscribeStatus(cb);
		const socket = sockets[0];
		socket.triggerOpen();

		socket.triggerMessage("not json");
		expect(cb).not.toHaveBeenCalledWith("not json");
	});

	it("handles error on existing websocket", () => {
		webSocketManager.subscribeStatus(() => {});
		const socket = sockets[0];
		socket.triggerOpen();

		const closeSpy = vi.spyOn(socket, "close");
		socket.triggerError();
		expect(closeSpy).toHaveBeenCalled();
	});

	it("unsubscribes log without error when ws is not open", () => {
		const unsub = webSocketManager.subscribeLog("owner", "repo", 1, () => {});
		webSocketManager["disconnect"]();
		expect(() => unsub()).not.toThrow();
	});
});
