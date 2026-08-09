import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import WebSocket from "ws";
import { createAdminWebSocketServer } from "./websocket-server.js";
import type { SessionLogEntry } from "../logging/session-log-store.js";
import { UserStore } from "../users/store.js";
import { AdminSessionAuth } from "../adapters/http/admin-auth.js";

// Shared admin account + signed session cookie for the protected upgrade tests.
const userDbPath = `/tmp/yolomatic-ws-integration-users-${process.pid}.sqlite`;
const userStore = new UserStore(userDbPath);
userStore.createSync({ fullName: "Admin", username: "admin", password: "secret" });
const sessionAuth = new AdminSessionAuth(userStore);

function mintSessionCookie(username: string, password: string): string {
	let cookie = "";
	const res = {
		setHeader(name: string, value: string) {
			if (name.toLowerCase() === "set-cookie") cookie = String(value);
		},
		getHeader() {
			return undefined;
		},
	} as unknown as Server; // ServerResponse stand-in
	const req = { headers: {}, socket: {} } as never;
	const user = sessionAuth.login(req, res as never, username, password);
	if (!user) throw new Error("failed to mint session cookie");
	return cookie.split(";")[0];
}
const validCookie = mintSessionCookie("admin", "secret");

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
			isAuthorized: () => true,
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/yolomatic/admin/ws`);
		await new Promise<void>((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});
		client.close();
	});

	it("rejects connections with invalid auth", async () => {
		if (socketBindingUnavailable) return;
		wsServer = createAdminWebSocketServer(httpServer, {
			isAuthorized: (req) => sessionAuth.isAdminAuthorized(req),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/yolomatic/admin/ws`);
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
			isAuthorized: (req) => sessionAuth.isAdminAuthorized(req),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/yolomatic/admin/ws`, {
			headers: {
				Cookie: validCookie,
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
			isAuthorized: (req) => sessionAuth.isAdminAuthorized(req),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/yolomatic/admin/ws`, {
			headers: {
				Cookie: validCookie,
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
			isAuthorized: (req) => sessionAuth.isAdminAuthorized(req),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/yolomatic/admin/ws`, {
			headers: {
				Cookie: validCookie,
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

		client.send(JSON.stringify({ type: "subscribe-log", owner: "mbrooks", repo: "yolomatic", issueNumber: 1, kind: "implementation" }));

		// Wait a tick for subscription to be processed
		await new Promise((r) => setTimeout(r, 50));

		const entry: SessionLogEntry = {
			timestamp: "2025-01-01T00:00:00.000Z",
			level: "info",
			message: "hello",
		};
		wsServer.broadcastLog("github-mbrooks-yolomatic-issue-1-implementation", entry);

		const msg = (await messagePromise) as { type: string; sessionKey: string; entry: SessionLogEntry };
		expect(msg.type).toBe("log-entry");
		expect(msg.sessionKey).toBe("github-mbrooks-yolomatic-issue-1-implementation");
		expect(msg.entry.message).toBe("hello");

		client.close();
	});

	it("does not broadcast log entries to unsubscribed clients", async () => {
		if (socketBindingUnavailable) return;
		wsServer = createAdminWebSocketServer(httpServer, {
			isAuthorized: (req) => sessionAuth.isAdminAuthorized(req),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/yolomatic/admin/ws`, {
			headers: {
				Cookie: validCookie,
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

		wsServer.broadcastLog("mbrooks/yolomatic#1", {
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
			isAuthorized: (req) => sessionAuth.isAdminAuthorized(req),
		}, statusProvider);

		const client = new WebSocket(`ws://127.0.0.1:${port}/yolomatic/admin/ws`, {
			headers: {
				Cookie: validCookie,
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
			isAuthorized: (req) => sessionAuth.isAdminAuthorized(req),
		}, statusProvider);

		const client = new WebSocket(`ws://127.0.0.1:${port}/yolomatic/admin/ws`, {
			headers: {
				Cookie: validCookie,
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
			isAuthorized: (req) => sessionAuth.isAdminAuthorized(req),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/yolomatic/admin/ws`, {
			headers: {
				Cookie: validCookie,
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
			isAuthorized: (req) => sessionAuth.isAdminAuthorized(req),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/yolomatic/admin/ws`, {
			headers: {
				Cookie: validCookie,
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
			isAuthorized: (req) => sessionAuth.isAdminAuthorized(req),
		});

		const client = new WebSocket(`ws://127.0.0.1:${port}/yolomatic/admin/ws`, {
			headers: {
				Cookie: validCookie,
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
			isAuthorized: () => true,
		});
		await expect(wsServer.close()).resolves.toBeUndefined();
	});

});
