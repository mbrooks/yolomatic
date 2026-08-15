import http from "node:http";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { createWebhookServer, cleanupOldSessions } from "./server.js";
import { AdminSessionAuth } from "../adapters/http/admin-auth.js";
import { UserStore } from "../users/store.js";
import { _resetSessionLogs, recordSessionLog } from "../logging/session-log-store.js";
import { sessionStorageKey } from "../session/store.js";
import type { SessionStore } from "../session/store.js";
import type { WorkerRpcServer } from "../worker/rpc-server.js";

// Real local HTTP + WebSocket. The only first-party double is the worker RPC
// server, which is an injected dependency option (a composition-boundary
// collaborator, not a module mock). External admin auth uses a real UserStore
// + AdminSessionAuth backed by a temp sqlite file.
const userDbPath = join(tmpdir(), "yolomatic-server-test-users.sqlite");
if (existsSync(userDbPath)) rmSync(userDbPath);
const userStore = new UserStore(userDbPath);
userStore.createSync({ fullName: "Admin", username: "admin", password: "secret" });
const sessionAuth = new AdminSessionAuth(userStore);

function mintSessionCookie(auth: AdminSessionAuth, username: string, password: string): string {
	let cookie = "";
	const res = {
		setHeader(name: string, value: string) {
			if (name.toLowerCase() === "set-cookie") cookie = String(value);
		},
		getHeader() {
			return undefined;
		},
	} as unknown as http.ServerResponse;
	const req = { headers: {}, socket: {} } as unknown as http.IncomingMessage;
	if (!auth.login(req, res, username, password)) throw new Error("failed to mint session cookie");
	return cookie.split(";")[0];
}
const validCookie = mintSessionCookie(sessionAuth, "admin", "secret");

function makeMockSessionStore(): SessionStore {
	return {
		get: vi.fn(),
		set: vi.fn(),
		exists: vi.fn(),
		getAll: vi.fn(async () => []),
		getSessionKey: vi.fn(),
		getSessionPath: vi.fn(),
		getStatePath: vi.fn(),
	} as unknown as SessionStore;
}

function makeRequest(
	port: number,
	options: http.RequestOptions,
	body?: string,
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ hostname: "127.0.0.1", port, ...options }, (res) => {
			let data = "";
			res.on("data", (chunk) => {
				data += chunk;
			});
			res.on("end", () => {
				resolve({ statusCode: res.statusCode ?? 0, body: data, headers: res.headers });
			});
		});
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

function sign(secret: string, payload: string): string {
	return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function startServer(options: Parameters<typeof createWebhookServer>[0]) {
	const server = createWebhookServer(options);
	return new Promise<{ server: http.Server; port: number }>((resolve) => {
		server.listen(0, () => {
			resolve({ server, port: (server.address() as { port: number }).port });
		});
	});
}

function openWebSocket(port: number, cookie = validCookie): Promise<WebSocket> {
	const client = new WebSocket(`ws://127.0.0.1:${port}/yolomatic/admin/ws`, {
		headers: cookie ? { Cookie: cookie } : undefined,
	});
	return new Promise<WebSocket>((resolve, reject) => {
		client.once("open", () => resolve(client));
		client.once("error", reject);
	});
}

function makeWorkerRpcDouble() {
	return {
		attach: vi.fn(),
		close: vi.fn(async () => undefined),
	} as unknown as WorkerRpcServer;
}

describe("createWebhookServer", () => {
	beforeEach(() => {
		_resetSessionLogs();
	});

	afterEach(() => {
		_resetSessionLogs();
	});

	describe("close cleanup", () => {
		it("attaches the worker RPC server to the HTTP server", async () => {
			const workerRpcServer = makeWorkerRpcDouble();
			const server = createWebhookServer({
				secret: "secret",
				handlers: { handleGitHubEvent: vi.fn(), isInFlight: vi.fn(() => false) },
				sessionStore: makeMockSessionStore(),
				userStore,
				sessionAuth,
				workerRpcServer,
			});
			await new Promise<void>((resolve) => server.listen(0, resolve));

			expect(workerRpcServer.attach).toHaveBeenCalledTimes(1);
			expect(workerRpcServer.attach).toHaveBeenCalledWith(server);

			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		it("stops accepting connections and closes the worker RPC server on close", async () => {
			const workerRpcServer = makeWorkerRpcDouble();
			const server = createWebhookServer({
				secret: "secret",
				handlers: { handleGitHubEvent: vi.fn(), isInFlight: vi.fn(() => false) },
				sessionStore: makeMockSessionStore(),
				userStore,
				sessionAuth,
				workerRpcServer,
			});
			await new Promise<void>((resolve) => server.listen(0, resolve));
			const port = (server.address() as { port: number }).port;

			// Sanity: the server accepts a request before close.
			await makeRequest(port, { method: "GET", path: "/yolomatic/admin" });

			await new Promise<void>((resolve) => server.close(() => resolve()));

			expect(workerRpcServer.close).toHaveBeenCalledTimes(1);

			// After close, new HTTP and WebSocket connections are refused.
			await expect(makeRequest(port, { method: "GET", path: "/yolomatic/admin" })).rejects.toThrow();
			const wsClient = new WebSocket(`ws://127.0.0.1:${port}/yolomatic/admin/ws`);
			await new Promise<void>((resolve) => wsClient.once("error", () => resolve()));
			wsClient.close();
		});

		it("invokes the close callback after the websocket and worker RPC cleanup settles", async () => {
			let rpcResolved = false;
			const workerRpcServer = {
				attach: vi.fn(),
				close: vi.fn(
					() =>
						new Promise<void>((resolve) => {
							setTimeout(() => {
								rpcResolved = true;
								resolve();
							}, 5);
						}),
				),
			} as unknown as WorkerRpcServer;

			const server = createWebhookServer({
				secret: "secret",
				handlers: { handleGitHubEvent: vi.fn(), isInFlight: vi.fn(() => false) },
				sessionStore: makeMockSessionStore(),
				userStore,
				sessionAuth,
				workerRpcServer,
			});
			await new Promise<void>((resolve) => server.listen(0, resolve));

			let callbackFired = false;
			await new Promise<void>((resolve) => {
				server.close(() => {
					callbackFired = true;
					resolve();
				});
			});

			expect(rpcResolved).toBe(true);
			expect(callbackFired).toBe(true);
		});
	});

	describe("session log broadcast lifecycle", () => {
		it("forwards subscribed session log events to the websocket client", async () => {
			const server = createWebhookServer({
				secret: "secret",
				handlers: { handleGitHubEvent: vi.fn(), isInFlight: vi.fn(() => false) },
				sessionStore: makeMockSessionStore(),
				userStore,
				sessionAuth,
			});
			await new Promise<void>((resolve) => server.listen(0, resolve));
			const port = (server.address() as { port: number }).port;

			const client = await openWebSocket(port);
			const sessionKey = sessionStorageKey("mbrooks", "yolomatic", 7, "implementation");
			const received = new Promise<unknown>((resolve) => {
				client.on("message", (raw) => resolve(JSON.parse(raw.toString())));
			});
			client.send(
				JSON.stringify({
					type: "subscribe-log",
					owner: "mbrooks",
					repo: "yolomatic",
					issueNumber: 7,
					kind: "implementation",
				}),
			);
			// Give the server a moment to register the subscription before emitting.
			await new Promise((resolve) => setTimeout(resolve, 50));

			recordSessionLog(sessionKey, { level: "info", message: "hello" });

			const message = await received;
			expect(message).toEqual({
				type: "log-entry",
				sessionKey,
				entry: expect.objectContaining({ level: "info", message: "hello" }),
			});

			client.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		it("stops forwarding session log events after the server closes", async () => {
			const server = createWebhookServer({
				secret: "secret",
				handlers: { handleGitHubEvent: vi.fn(), isInFlight: vi.fn(() => false) },
				sessionStore: makeMockSessionStore(),
				userStore,
				sessionAuth,
			});
			await new Promise<void>((resolve) => server.listen(0, resolve));
			const port = (server.address() as { port: number }).port;

			const client = await openWebSocket(port);
			const sessionKey = sessionStorageKey("mbrooks", "yolomatic", 8, "implementation");
			client.send(
				JSON.stringify({
					type: "subscribe-log",
					owner: "mbrooks",
					repo: "yolomatic",
					issueNumber: 8,
					kind: "implementation",
				}),
			);
			// Let the server register the subscription.
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Confirm the subscription is live by receiving one broadcast.
			const firstReceived = new Promise<unknown>((resolve) => {
				client.once("message", (raw) => resolve(JSON.parse(raw.toString())));
			});
			recordSessionLog(sessionKey, { level: "info", message: "before-close" });
			await firstReceived;

			// stopLogEvents() runs synchronously inside close(), so the log
			// subscription is detached before any await on the close callback.
			server.close();

			let receivedAfterClose = false;
			client.once("message", () => {
				receivedAfterClose = true;
			});

			// Emitting after close must not throw and must not broadcast.
			expect(() => recordSessionLog(sessionKey, { level: "info", message: "after-close" })).not.toThrow();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(receivedAfterClose).toBe(false);

			client.close();
		});
	});

	it("allows websocket upgrades without credentials in onboarding mode", async () => {
		const server = createWebhookServer({
			secret: "secret",
			handlers: { handleGitHubEvent: vi.fn(), isInFlight: vi.fn(() => false) },
			sessionStore: makeMockSessionStore(),
		});
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		// No userStore/sessionAuth configured → onboarding mode → upgrade allowed.
		const client = new WebSocket(`ws://127.0.0.1:${port}/yolomatic/admin/ws`);
		await new Promise<void>((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});

		client.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	describe("request handling", () => {
		it("returns 404 for non-webhook routes", async () => {
			const { server, port } = await startServer({
				secret: "secret",
				handlers: { handleGitHubEvent: vi.fn(), isInFlight: vi.fn(() => false) },
				sessionStore: makeMockSessionStore(),
			});

			const getRes = await makeRequest(port, { method: "GET", path: "/webhook" });
			expect(getRes.statusCode).toBe(404);
			expect(getRes.body).toBe("Not found");

			const postRes = await makeRequest(port, { method: "POST", path: "/" });
			expect(postRes.statusCode).toBe(404);

			server.close();
		});

		it("rejects webhook posts with an invalid signature and returns 401", async () => {
			const { server, port } = await startServer({
				secret: "secret",
				handlers: { handleGitHubEvent: vi.fn(), isInFlight: vi.fn(() => false) },
				sessionStore: makeMockSessionStore(),
			});

			const res = await makeRequest(
				port,
				{ method: "POST", path: "/webhook", headers: { "x-github-event": "issues", "x-hub-signature-256": "sha256=bad" } },
				'{"action":"opened"}',
			);
			expect(res.statusCode).toBe(401);
			expect(res.body).toBe("Invalid signature");

			server.close();
		});

		it("dispatches a signed issues webhook and returns 200", async () => {
			const handleGitHubEvent = vi.fn(async () => {});
			const { server, port } = await startServer({
				secret: "secret",
				handlers: { handleGitHubEvent, isInFlight: vi.fn(() => false) },
				sessionStore: makeMockSessionStore(),
			});

			const payload = JSON.stringify({
				action: "opened",
				issue: { number: 12, created_at: "2026-08-15T00:00:00.000Z" },
				repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			});
			const res = await makeRequest(
				port,
				{ method: "POST", path: "/webhook", headers: { "x-github-event": "issues", "x-github-delivery": "d1", "x-hub-signature-256": sign("secret", payload) } },
				payload,
			);
			expect(res.statusCode).toBe(200);
			expect(res.body).toBe("OK");
			expect(handleGitHubEvent).toHaveBeenCalledWith(
				expect.objectContaining({ type: "issue", owner: "mbrooks", repo: "yolomatic", source: "webhook" }),
			);

			server.close();
		});

		it("dispatches a signed issue_comment webhook and returns 200", async () => {
			const handleGitHubEvent = vi.fn(async () => {});
			const { server, port } = await startServer({
				secret: "secret",
				handlers: { handleGitHubEvent, isInFlight: vi.fn(() => false) },
				sessionStore: makeMockSessionStore(),
			});

			const payload = JSON.stringify({
				action: "created",
				comment: { id: 4, body: "hi", created_at: "2026-08-15T00:00:00.000Z" },
				repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			});
			const res = await makeRequest(
				port,
				{ method: "POST", path: "/webhook", headers: { "x-github-event": "issue_comment", "x-hub-signature-256": sign("secret", payload) } },
				payload,
			);
			expect(res.statusCode).toBe(200);
			expect(handleGitHubEvent).toHaveBeenCalledWith(
				expect.objectContaining({ type: "issue_comment", payload: expect.objectContaining({ action: "created" }) }),
			);

			server.close();
		});

		it("returns 200 and ignores unsupported events without invoking the handler", async () => {
			const handleGitHubEvent = vi.fn(async () => {});
			const { server, port } = await startServer({
				secret: "secret",
				handlers: { handleGitHubEvent, isInFlight: vi.fn(() => false) },
				sessionStore: makeMockSessionStore(),
			});

			const payload = '{"action":"noop"}';
			const res = await makeRequest(
				port,
				{ method: "POST", path: "/webhook", headers: { "x-github-event": "ping", "x-hub-signature-256": sign("secret", payload) } },
				payload,
			);
			expect(res.statusCode).toBe(200);
			expect(handleGitHubEvent).not.toHaveBeenCalled();

			server.close();
		});

		it("returns 200 and ignores events missing the x-github-event header", async () => {
			const handleGitHubEvent = vi.fn(async () => {});
			const { server, port } = await startServer({
				secret: "secret",
				handlers: { handleGitHubEvent, isInFlight: vi.fn(() => false) },
				sessionStore: makeMockSessionStore(),
			});

			const payload = '{"action":"opened"}';
			const res = await makeRequest(
				port,
				{ method: "POST", path: "/webhook", headers: { "x-hub-signature-256": sign("secret", payload) } },
				payload,
			);
			expect(res.statusCode).toBe(200);
			expect(handleGitHubEvent).not.toHaveBeenCalled();

			server.close();
		});

		it("returns 500 with the handler error message when dispatch throws", async () => {
			const handleGitHubEvent = vi.fn(async () => {
				throw new Error("boom");
			});
			const { server, port } = await startServer({
				secret: "secret",
				handlers: { handleGitHubEvent, isInFlight: vi.fn(() => false) },
				sessionStore: makeMockSessionStore(),
			});

			const payload = JSON.stringify({
				action: "created",
				comment: { id: 1, created_at: "2026-08-15T00:00:00.000Z" },
				repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			});
			const res = await makeRequest(
				port,
				{ method: "POST", path: "/webhook", headers: { "x-github-event": "issue_comment", "x-hub-signature-256": sign("secret", payload) } },
				payload,
			);
			expect(res.statusCode).toBe(500);
			expect(res.body).toBe("boom");

			server.close();
		});

		it("delegates to admin routes for admin paths and returns their response", async () => {
			const { server, port } = await startServer({
				secret: "secret",
				handlers: { handleGitHubEvent: vi.fn(), isInFlight: vi.fn(() => false) },
				sessionStore: makeMockSessionStore(),
			});

			// /api/status without configured admin credentials returns 503,
			// proving the admin router handled the request (not the webhook 404).
			const res = await makeRequest(port, { method: "GET", path: "/api/status" });
			expect(res.statusCode).toBe(503);

			server.close();
		});
	});

});

describe("cleanupOldSessions", () => {
	it("deletes terminal sessions older than the retention window", async () => {
		const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
		const deleteFn = vi.fn(async () => undefined);
		const sessionStore = {
			getAll: vi.fn(async () => [
				{
					owner: "mbrooks",
					repo: "yolomatic",
					issueNumber: 1,
					status: "complete",
					lastActivity: oldDate,
					kind: "implementation",
				},
				{
					owner: "mbrooks",
					repo: "yolomatic",
					issueNumber: 2,
					status: "working",
					lastActivity: oldDate,
					kind: "implementation",
				},
			]),
			delete: deleteFn,
		} as unknown as SessionStore;

		// No workspace manager → fallback workspace service (no-op removeWorktree).
		const result = await cleanupOldSessions(sessionStore, undefined, 30);

		expect(result).toEqual({ deleted: 1, failed: 0 });
		expect(deleteFn).toHaveBeenCalledWith("mbrooks", "yolomatic", 1, "implementation");
		// The non-terminal working session is left alone.
		expect(deleteFn).toHaveBeenCalledTimes(1);
	});

	it("counts a failed deletion when workspace removal throws", async () => {
		const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
		const sessionStore = {
			getAll: vi.fn(async () => [
				{
					owner: "mbrooks",
					repo: "yolomatic",
					issueNumber: 3,
					status: "failed",
					lastActivity: oldDate,
					kind: "implementation",
				},
			]),
			delete: vi.fn(async () => undefined),
		} as unknown as SessionStore;
		const workspaceManager = {
			removeWorktree: vi.fn(async () => {
				throw new Error("boom");
			}),
		} as never;

		const result = await cleanupOldSessions(sessionStore, workspaceManager, 30);

		expect(result).toEqual({ deleted: 0, failed: 1 });
	});
});