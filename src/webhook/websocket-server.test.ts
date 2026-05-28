import { createServer, type Server } from "node:http";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import WebSocket from "ws";
import { createAdminWebSocketServer } from "./websocket-server.js";
import type { SessionLogEntry } from "../logging/session-log-store.js";

describe("createAdminWebSocketServer", () => {
	let httpServer: Server;
	let port: number;
	let wsServer: ReturnType<typeof createAdminWebSocketServer>;

	beforeEach(async () => {
		httpServer = createServer((req, res) => {
			res.writeHead(200);
			res.end("ok");
		});
		await new Promise<void>((resolve) => {
			httpServer.listen(0, () => {
				const address = httpServer.address();
				port = typeof address === "object" && address !== null ? address.port : 0;
				resolve();
			});
		});
	});

	afterEach(async () => {
		if (wsServer) {
			await wsServer.close();
		}
		httpServer.closeAllConnections?.();
		httpServer.close();
	});

	it("accepts connections without auth in onboarding mode", async () => {
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({}),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		await new Promise<void>((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});
		client.close();
	});

	it("rejects connections with invalid auth", async () => {
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		await expect(
			new Promise<void>((resolve, reject) => {
				client.once("open", resolve);
				client.once("error", (err) => reject(err));
			}),
		).rejects.toThrow();
	});

	it("accepts connections with valid basic auth header", async () => {
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});
		await new Promise<void>((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});
		client.close();
	});

	it("broadcasts log entries to subscribed clients", async () => {
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});

		await new Promise<void>((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});

		const messagePromise = new Promise<unknown>((resolve) => {
			client.once("message", (data) => {
				resolve(JSON.parse(data.toString()));
			});
		});

		client.send(JSON.stringify({ type: "subscribe-log", owner: "mbrooks", repo: "tars", issueNumber: 1 }));

		// Wait a tick for subscription to be processed
		await new Promise((r) => setTimeout(r, 50));

		const entry: SessionLogEntry = {
			timestamp: "2025-01-01T00:00:00.000Z",
			level: "info",
			message: "hello",
		};
		wsServer.broadcastLog("mbrooks/tars#1", entry);

		const msg = (await messagePromise) as { type: string; sessionKey: string; entry: SessionLogEntry };
		expect(msg.type).toBe("log-entry");
		expect(msg.sessionKey).toBe("mbrooks/tars#1");
		expect(msg.entry.message).toBe("hello");

		client.close();
	});

	it("does not broadcast log entries to unsubscribed clients", async () => {
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});

		await new Promise<void>((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});

		// Subscribe to a different session
		client.send(JSON.stringify({ type: "subscribe-log", owner: "other", repo: "repo", issueNumber: 99 }));
		await new Promise((r) => setTimeout(r, 50));

		const received = vi.fn();
		client.on("message", received);

		wsServer.broadcastLog("mbrooks/tars#1", {
			timestamp: "2025-01-01T00:00:00.000Z",
			level: "info",
			message: "hello",
		});

		await new Promise((r) => setTimeout(r, 100));
		expect(received).not.toHaveBeenCalled();

		client.close();
	});

	it("broadcasts status to subscribed clients", async () => {
		const statusProvider = {
			getStatus: vi.fn().mockResolvedValue({ agent: "online" }),
		};
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		}, statusProvider);

		const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});

		await new Promise<void>((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});

		const messagePromise = new Promise<unknown>((resolve) => {
			client.once("message", (data) => {
				resolve(JSON.parse(data.toString()));
			});
		});

		client.send(JSON.stringify({ type: "subscribe-status" }));
		await new Promise((r) => setTimeout(r, 100));

		const msg = (await messagePromise) as { type: string; data: unknown };
		expect(msg.type).toBe("status");
		expect(msg.data).toEqual({ agent: "online" });

		client.close();
	});

	it("stops status polling when last subscriber unsubscribes", async () => {
		const statusProvider = {
			getStatus: vi.fn().mockResolvedValue({ agent: "online" }),
		};
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		}, statusProvider);

		const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});

		await new Promise<void>((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});

		client.send(JSON.stringify({ type: "subscribe-status" }));
		await new Promise((r) => setTimeout(r, 100));

		client.send(JSON.stringify({ type: "unsubscribe-status" }));
		await new Promise((r) => setTimeout(r, 100));

		// Should not have thrown
		client.close();
	});

	it("disconnects client on error event", async () => {
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});

		await new Promise<void>((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});

		// Force an error on the underlying socket to trigger ws error event
		for (const ws of (wsServer as any).wss?.clients ?? []) {
			ws.emit("error", new Error("mock error"));
		}

		// Give a moment for error handler to run
		await new Promise((r) => setTimeout(r, 50));
		client.close();
	});

	it("directly broadcasts status to subscribers", async () => {
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});

		await new Promise<void>((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});

		client.send(JSON.stringify({ type: "subscribe-status" }));
		await new Promise((r) => setTimeout(r, 100));

		const received = vi.fn();
		client.on("message", received);

		wsServer.broadcastStatus({ agent: "busy" });
		await new Promise((r) => setTimeout(r, 100));

		expect(received).toHaveBeenCalled();
		const payload = JSON.parse(received.mock.calls[0][0].toString()) as { type: string; data: unknown };
		expect(payload.type).toBe("status");
		expect(payload.data).toEqual({ agent: "busy" });

		client.close();
	});

	it("ignores invalid JSON messages", async () => {
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});

		await new Promise<void>((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});

		client.send("not json");
		await new Promise((r) => setTimeout(r, 100));

		// Should not crash
		client.close();
	});

	it("handles close gracefully", async () => {
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({}),
		});
		await expect(wsServer.close()).resolves.toBeUndefined();
	});
});
