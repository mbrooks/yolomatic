import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import WebSocket from "ws";
import { createAdminWebSocketServer } from "./websocket-server.js";
import type { SessionLogEntry } from "../logging/session-log-store.js";

describe("createAdminWebSocketServer", () => {
	let httpServer: Server;
	let port: number;
	let wsServer: ReturnType<typeof createAdminWebSocketServer>;
	let socketBindingUnavailable = false;

	beforeEach(async () => {
		socketBindingUnavailable = false;
		httpServer = createServer((req, res) => {
			res.writeHead(200);
			res.end("ok");
		});
		await new Promise<void>((resolve, reject) => {
			const handleError = (error: NodeJS.ErrnoException) => {
				httpServer.off("error", handleError);
				if (error.code === "EPERM") {
					socketBindingUnavailable = true;
					resolve();
					return;
				}
				reject(error);
			};
			httpServer.once("error", handleError);
			httpServer.listen(0, () => {
				httpServer.off("error", handleError);
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
		if (httpServer.listening) {
			httpServer.closeAllConnections?.();
			await new Promise<void>((resolve, reject) => {
				httpServer.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		}
	});

	it("accepts connections without auth in onboarding mode", async () => {
		if (socketBindingUnavailable) return;
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({}),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/tarsadmin/ws`);
		await new Promise<void>((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});
		client.close();
	});

	it("rejects connections with invalid auth", async () => {
		if (socketBindingUnavailable) return;
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/tarsadmin/ws`);
		await expect(
			new Promise<void>((resolve, reject) => {
				client.once("open", resolve);
				client.once("error", (err) => reject(err));
			}),
		).rejects.toThrow();
	});

	it("accepts connections with valid basic auth header", async () => {
		if (socketBindingUnavailable) return;
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/tarsadmin/ws`, {
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

	it("accepts connections with a valid admin session cookie", async () => {
		if (socketBindingUnavailable) return;
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		});

		const expiresAt = Math.floor(Date.now() / 1000) + 3600;
		const signature = createHmac("sha256", "secret")
			.update(`admin:${expiresAt}`)
			.digest("base64url");
		const token = Buffer.from(JSON.stringify({
			username: "admin",
			expiresAt,
			signature,
		}), "utf8").toString("base64url");

		const client = new WebSocket(`ws://127.0.0.1:${port}/tarsadmin/ws`, {
			headers: {
				Cookie: `tars_admin_session=${token}`,
			},
		});
		await new Promise<void>((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});
		client.close();
	});

	it("broadcasts log entries to subscribed clients", async () => {
		if (socketBindingUnavailable) return;
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/tarsadmin/ws`, {
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
		if (socketBindingUnavailable) return;
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/tarsadmin/ws`, {
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
		if (socketBindingUnavailable) return;
		const statusProvider = {
			getStatus: vi.fn().mockResolvedValue({ agent: "online" }),
		};
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		}, statusProvider);

		const client = new WebSocket(`ws://127.0.0.1:${port}/tarsadmin/ws`, {
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
		if (socketBindingUnavailable) return;
		const statusProvider = {
			getStatus: vi.fn().mockResolvedValue({ agent: "online" }),
		};
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		}, statusProvider);

		const client = new WebSocket(`ws://127.0.0.1:${port}/tarsadmin/ws`, {
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
		if (socketBindingUnavailable) return;
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/tarsadmin/ws`, {
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
		if (socketBindingUnavailable) return;
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/tarsadmin/ws`, {
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
		if (socketBindingUnavailable) return;
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/tarsadmin/ws`, {
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
		if (socketBindingUnavailable) return;
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({}),
		});
		await expect(wsServer.close()).resolves.toBeUndefined();
	});

	it("runs issue chat over websocket and streams progress", async () => {
		if (socketBindingUnavailable) return;
		const issueChatProvider = {
			runIssueChat: vi.fn(async (_requestId, _payload, onProgress) => {
				onProgress({ type: "started", message: "Thinking..." });
				onProgress({ type: "creating", message: "Creating issue..." });
				return {
					message: "Created",
					owner: "mbrooks",
					repo: "tars",
					draft: { title: "Bug", body: "Body", labels: ["bug"], assignees: [] },
					readyToCreate: true,
					shouldCreate: true,
					createdIssue: { number: 42, html_url: "http://issue/42" },
				};
			}),
		};
		wsServer = createAdminWebSocketServer(httpServer, {
			getCredentials: () => ({ username: "admin", password: "secret" }),
		}, undefined, issueChatProvider);

		const client = new WebSocket(`ws://127.0.0.1:${port}/tarsadmin/ws`, {
			headers: {
				Authorization: "Basic " + Buffer.from("admin:secret").toString("base64"),
			},
		});

		await new Promise<void>((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});

		const messages: unknown[] = [];
		client.on("message", (data) => {
			messages.push(JSON.parse(data.toString()));
		});

		client.send(JSON.stringify({
			type: "issue-chat",
			requestId: "req-1",
			payload: {
				owner: "mbrooks",
				repo: "tars",
				messages: [{ role: "user", text: "hello" }],
			},
		}));

		await new Promise((r) => setTimeout(r, 100));

		expect(issueChatProvider.runIssueChat).toHaveBeenCalled();
		expect(messages).toContainEqual({
			type: "issue-chat-progress",
			requestId: "req-1",
			event: { type: "started", message: "Thinking..." },
		});
		expect(messages).toContainEqual({
			type: "issue-chat-response",
			requestId: "req-1",
			response: {
				message: "Created",
				owner: "mbrooks",
				repo: "tars",
				draft: { title: "Bug", body: "Body", labels: ["bug"], assignees: [] },
				readyToCreate: true,
				shouldCreate: true,
				createdIssue: { number: 42, html_url: "http://issue/42" },
			},
		});

		client.close();
	});
});
