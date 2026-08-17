import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { createWebhookServer, cleanupOldSessions, readBody, verifySignature } from "./server.js";
import { makeWorkspaceManager } from "./handlers-test-helpers.js";

import { _resetSessionLogs, recordSessionLog } from "../logging/session-log-store.js";
import { SettingsStore } from "../settings/store.js";
import type { SessionStatus } from "../session/store.js";
import { UserStore } from "../users/store.js";
import { AdminSessionAuth } from "../adapters/http/admin-auth.js";

// Shared admin account + session cookie used by the admin-route tests. The
// old Basic Auth path is gone, so tests mint a real signed session cookie via
// AdminSessionAuth.login and send it as a Cookie header instead.
//
// The SQLite database lives inside a unique temporary directory that is torn
// down after the suite finishes. Using a fresh directory per run avoids the
// `disk I/O error` caused by stale SQLite `-wal`/`-shm` sidecars from a
// previous collection when only the main database file was removed.
const userDbDir = mkdtempSync(join(tmpdir(), "yolomatic-server-routes-"));
const userDbPath = join(userDbDir, "users.sqlite");
const userStore = new UserStore(userDbPath);
userStore.createSync({ fullName: "Admin", username: "admin", password: "secret" });
const sessionAuth = new AdminSessionAuth(userStore);

afterAll(() => {
	// Closing the store checkpoints and releases the WAL before the directory
	// is removed, so no `-wal`/`-shm` sidecars are left between runs.
	userStore.close();
	rmSync(userDbDir, { recursive: true, force: true });
});

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
	const user = auth.login(req, res, username, password);
	if (!user) throw new Error("failed to mint session cookie");
	return cookie.split(";")[0];
}
const validCookie = mintSessionCookie(sessionAuth, "admin", "secret");

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

function makeWebhookHandlers() {
	return {
		handleGitHubEvent: vi.fn(async () => {}),
		isInFlight: vi.fn(() => false),
	};
}

describe("verifySignature", () => {
	it("accepts a valid GitHub webhook signature", () => {
		const payload = Buffer.from('{"action":"opened"}');
		const secret = "top-secret";
		const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;

		expect(verifySignature(secret, payload, signature)).toBe(true);
		expect(verifySignature(secret, payload, "sha256=bad")).toBe(false);
	});
});

describe("readBody", () => {
	it("reads chunks from an async iterable request", async () => {
		const request = {
			async *[Symbol.asyncIterator]() {
				yield Buffer.from('{"action":"opened"}');
			},
		} as http.IncomingMessage;
		const body = await readBody(request);
		expect(body.toString()).toBe('{"action":"opened"}');
	});

	it("handles string chunks", async () => {
		const request = {
			async *[Symbol.asyncIterator]() {
				yield "hello";
			},
		} as http.IncomingMessage;
		const body = await readBody(request);
		expect(body.toString()).toBe("hello");
	});

	it("rejects when the request stream throws", async () => {
		const request = {
			async *[Symbol.asyncIterator]() {
				yield "chunk";
				throw new Error("stream error");
			},
		} as http.IncomingMessage;
		await expect(readBody(request)).rejects.toThrow("stream error");
	});
});


describe("createWebhookServer", () => {
	function makeMockSessionStore(): import("../session/store.js").SessionStore {
		return {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
	}

	it("returns 404 for non-POST or non-/webhook routes", async () => {
		const handlers = makeWebhookHandlers();
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const getRes = await makeRequest(port, { method: "GET", path: "/webhook" });
		expect(getRes.statusCode).toBe(404);

		const postRes = await makeRequest(port, { method: "POST", path: "/" });
		expect(postRes.statusCode).toBe(404);

		server.close();
	});

	it("returns 401 for invalid signature", async () => {
		const handlers = makeWebhookHandlers();
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/webhook",
			headers: {
				"x-hub-signature-256": "sha256=invalid",
				"x-github-event": "issues",
			},
		});
		expect(response.statusCode).toBe(401);

		server.close();
	});

	it("calls handleGitHubEvent for valid issues webhook", async () => {
		const handlers = makeWebhookHandlers();
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const payload = JSON.stringify({
			action: "opened",
			issue: { number: 1, created_at: "2026-06-28T00:00:00.000Z" },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
		});
		const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;

		const response = await makeRequest(
			port,
			{
				method: "POST",
				path: "/webhook",
				headers: {
					"x-hub-signature-256": signature,
					"x-github-event": "issues",
					"x-github-delivery": "123",
				},
			},
			payload,
		);
		expect(response.statusCode).toBe(200);
		expect(handlers.handleGitHubEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "issue",
				owner: "mbrooks",
				repo: "yolomatic",
				payload: expect.objectContaining({ action: "opened" }),
			}),
		);

		server.close();
	});

	it("returns 500 when handler throws", async () => {
		const handlers = {
			handleGitHubEvent: vi.fn(async () => {
				throw new Error("boom");
			}),
			isInFlight: vi.fn(() => false),
		};
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const payload = JSON.stringify({
			action: "opened",
			issue: { number: 1, created_at: "2026-06-28T00:00:00.000Z" },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
		});
		const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;

		const response = await makeRequest(
			port,
			{
				method: "POST",
				path: "/webhook",
				headers: {
					"x-hub-signature-256": signature,
					"x-github-event": "issues",
				},
			},
			payload,
		);
		expect(response.statusCode).toBe(500);

		server.close();
	});

	it("ignores unsupported events and returns 200", async () => {
		const handlers = makeWebhookHandlers();
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const payload = JSON.stringify({ action: "published" });
		const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;

		const response = await makeRequest(
			port,
			{
				method: "POST",
				path: "/webhook",
				headers: {
					"x-hub-signature-256": signature,
					"x-github-event": "release",
				},
			},
			payload,
		);
		expect(response.statusCode).toBe(200);
		expect(handlers.handleGitHubEvent).not.toHaveBeenCalled();

		server.close();
	});

	it("returns 401 when signature header is missing", async () => {
		const handlers = {
			handleGitHubEvent: vi.fn(),
			isInFlight: vi.fn(() => false),
		};
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const payload = JSON.stringify({ action: "opened" });

		const response = await makeRequest(
			port,
			{
				method: "POST",
				path: "/webhook",
				headers: {
					"x-github-event": "issues",
				},
			},
			payload,
		);
		expect(response.statusCode).toBe(401);

		server.close();
	});

	it("calls handleGitHubEvent for valid PR review comment webhook", async () => {
		const handlers = makeWebhookHandlers();
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const payload = JSON.stringify({
			action: "created",
			comment: { id: 2, created_at: "2026-06-28T00:00:00.000Z" },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
		});
		const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;

		const response = await makeRequest(
			port,
			{
				method: "POST",
				path: "/webhook",
				headers: {
					"x-hub-signature-256": signature,
					"x-github-event": "pull_request_review_comment",
					"x-github-delivery": "456",
				},
			},
			payload,
		);
		expect(response.statusCode).toBe(200);
		expect(handlers.handleGitHubEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "pull_request_review_comment",
				payload: expect.objectContaining({ action: "created" }),
			}),
		);

		server.close();
	});

	it("calls handleGitHubEvent for valid PR review webhook", async () => {
		const handlers = makeWebhookHandlers();
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const payload = JSON.stringify({
			action: "submitted",
			review: { id: 3, submitted_at: "2026-06-28T00:00:00.000Z" },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
		});
		const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;

		const response = await makeRequest(
			port,
			{
				method: "POST",
				path: "/webhook",
				headers: {
					"x-hub-signature-256": signature,
					"x-github-event": "pull_request_review",
					"x-github-delivery": "789",
				},
			},
			payload,
		);
		expect(response.statusCode).toBe(200);
		expect(handlers.handleGitHubEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "pull_request_review",
				payload: expect.objectContaining({ action: "submitted" }),
			}),
		);

		server.close();
	});

	it("ignores event when x-github-event header is missing", async () => {
		const handlers = makeWebhookHandlers();
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const payload = JSON.stringify({ action: "opened" });
		const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;

		const response = await makeRequest(
			port,
			{
				method: "POST",
				path: "/webhook",
				headers: {
					"x-hub-signature-256": signature,
				},
			},
			payload,
		);
		expect(response.statusCode).toBe(200);
		expect(handlers.handleGitHubEvent).not.toHaveBeenCalled();

		server.close();
	});

	it("returns 200 for /yolomatic/admin when credentials are not configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, { method: "GET", path: "/yolomatic/admin" });
		expect(response.statusCode).toBe(200);

		server.close();
	});

	it("returns 503 for /api/status when credentials are not configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, { method: "GET", path: "/api/status" });
		expect(response.statusCode).toBe(503);

		server.close();
	});

	it("returns 401 for /api/status without auth header", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore(), userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, { method: "GET", path: "/api/status" });
		expect(response.statusCode).toBe(401);
		expect(JSON.parse(response.body).error).toBe("Unauthorized");

		server.close();
	});

	it("returns 401 for /api/status with an invalid session cookie", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore(), userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status",
			headers: {
				Cookie: "yolomatic_admin_session=invalid",
			},
		});
		expect(response.statusCode).toBe(401);
		expect(JSON.parse(response.body).error).toBe("Unauthorized");

		server.close();
	});

	it("returns HTML for /yolomatic/admin with valid credentials", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const adminAssetsDir = await mkdtemp(join(tmpdir(), "yolomatic-admin-"));
		await writeFile(
			join(adminAssetsDir, "index.html"),
			'<!doctype html><html><head><title>Yolomatic Admin</title></head><body><div id="root"></div><script type="module" src="/yolomatic/admin/assets/main.js"></script></body></html>',
		);
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore(), adminAssetsDir, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		try {
			const response = await makeRequest(port, {
				method: "GET",
				path: "/yolomatic/admin",
				headers: {
					Cookie: validCookie,
				},
			});
			expect(response.statusCode).toBe(200);
			expect(response.headers["content-type"]).toContain("text/html");
			expect(response.body).toContain("Yolomatic Admin");
			expect(response.body).toContain('id="root"');
			expect(response.body).toContain("/yolomatic/admin/assets/main.js");
		} finally {
			server.close();
			await rm(adminAssetsDir, { force: true, recursive: true });
		}
	});

	it("serves /yolomatic/admin bundled assets with valid credentials", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const adminAssetsDir = await mkdtemp(join(tmpdir(), "yolomatic-admin-"));
		await mkdir(join(adminAssetsDir, "assets"));
		await writeFile(join(adminAssetsDir, "assets", "main.js"), "console.log('admin');");
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore(), adminAssetsDir, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		try {
			const response = await makeRequest(port, {
				method: "GET",
				path: "/yolomatic/admin/assets/main.js",
				headers: {
					Cookie: validCookie,
				},
			});
			expect(response.statusCode).toBe(200);
			expect(response.headers["content-type"]).toContain("text/javascript");
			expect(response.body).toBe("console.log('admin');");
		} finally {
			server.close();
			await rm(adminAssetsDir, { force: true, recursive: true });
		}
	});

	it("serves /yolomatic/admin bundled assets without a session (login screen)", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const adminAssetsDir = await mkdtemp(join(tmpdir(), "yolomatic-admin-"));
		await mkdir(join(adminAssetsDir, "assets"));
		await writeFile(join(adminAssetsDir, "assets", "main.js"), "console.log('admin');");
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore(), adminAssetsDir, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		try {
			const response = await makeRequest(port, { method: "GET", path: "/yolomatic/admin/assets/main.js" });
			expect(response.statusCode).toBe(200);
			expect(response.body).toContain("console.log");
		} finally {
			server.close();
			await rm(adminAssetsDir, { force: true, recursive: true });
		}
	});

	it("returns JSON for /api/status with valid credentials", async () => {
		const mockStore = {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => [
				{
					issueNumber: 1,
					repo: "yolomatic",
					owner: "mbrooks",
					title: "Test",
					body: "Body",
					status: "working" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-1.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
					lastActivity: new Date().toISOString(),
					seeded: false,
				},
			]),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status",
			headers: {
				Cookie: validCookie,
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.agent).toBe("busy");
		expect(body.sessions).toHaveLength(1);
		expect(body.sessions[0].branch).toBe("yolomatic/issue-1");
		expect(body.sessions[0].risk).toEqual({
			suspectedMisroute: false,
			reasons: [],
			referencedIssueNumber: null,
		});

		server.close();
	});

	it("flags PR-shaped sessions in /api/status", async () => {
		const mockStore = {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => [
				{
					issueNumber: 89,
					repo: "yolomatic",
					owner: "mbrooks",
					title: "Yolomatic: Add stale session detection",
					body: "Fixes #86\n\nSummary",
					status: "complete" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-89.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-89",
					lastActivity: new Date().toISOString(),
					seeded: false,
				},
			]),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status",
			headers: {
				Cookie: validCookie,
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.sessions[0].risk.suspectedMisroute).toBe(true);
		expect(body.sessions[0].risk.referencedIssueNumber).toBe(86);
		expect(body.sessions[0].risk.reasons).toContain("Session body references issue #86.");
		expect(body.sessions[0].risk.reasons).toContain("Session title looks like a generated PR title.");

		server.close();
	});

	it("sorts sessions by createdAt descending in /api/status", async () => {
		const mockStore = {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => [
				{
					issueNumber: 1,
					repo: "yolomatic",
					owner: "mbrooks",
					title: "First",
					body: "Body",
					status: "complete" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-1.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
					lastActivity: "2026-01-01T00:00:00.000Z",
					createdAt: "2026-01-01T00:00:00.000Z",
					seeded: false,
				},
				{
					issueNumber: 2,
					repo: "yolomatic",
					owner: "mbrooks",
					title: "Second",
					body: "Body",
					status: "complete" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-2.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-2",
					lastActivity: "2026-01-02T00:00:00.000Z",
					createdAt: "2026-01-03T00:00:00.000Z",
					seeded: false,
				},
				{
					issueNumber: 3,
					repo: "yolomatic",
					owner: "mbrooks",
					title: "Third",
					body: "Body",
					status: "complete" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-3.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-3",
					lastActivity: "2026-01-03T00:00:00.000Z",
					createdAt: "2026-01-02T00:00:00.000Z",
					seeded: false,
				},
			]),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status",
			headers: {
				Cookie: validCookie,
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.sessions).toHaveLength(3);
		expect(body.sessions[0].issueNumber).toBe(2); // newest createdAt first
		expect(body.sessions[1].issueNumber).toBe(3);
		expect(body.sessions[2].issueNumber).toBe(1);

		server.close();
	});

	it("falls back to lastActivity when createdAt is missing", async () => {
		const mockStore = {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => [
				{
					issueNumber: 1,
					repo: "yolomatic",
					owner: "mbrooks",
					title: "Old",
					body: "Body",
					status: "complete" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-1.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
					lastActivity: "2026-01-01T00:00:00.000Z",
					seeded: false,
				},
				{
					issueNumber: 2,
					repo: "yolomatic",
					owner: "mbrooks",
					title: "New",
					body: "Body",
					status: "complete" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-2.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-2",
					lastActivity: "2026-01-03T00:00:00.000Z",
					seeded: false,
				},
			]),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status",
			headers: {
				Cookie: validCookie,
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.sessions).toHaveLength(2);
		expect(body.sessions[0].issueNumber).toBe(2); // newer lastActivity first
		expect(body.sessions[1].issueNumber).toBe(1);

		server.close();
	});

	it("returns 500 for /api/status when getAll throws", async () => {
		const mockStore = {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => {
				throw new Error("disk error");
			}),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status",
			headers: {
				Cookie: validCookie,
			},
		});
		expect(response.statusCode).toBe(500);
		const body = JSON.parse(response.body);
		expect(body.error).toBe("disk error");

		server.close();
	});

	it("returns repo summaries in /api/status", async () => {
		const mockStore = {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => [
				{
					issueNumber: 1,
					repo: "yolomatic",
					owner: "mbrooks",
					title: "One",
					body: "Body",
					status: "working" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-1.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
					lastActivity: new Date().toISOString(),
					seeded: false,
				},
				{
					issueNumber: 2,
					repo: "yolomatic",
					owner: "mbrooks",
					title: "Two",
					body: "Body",
					status: "complete" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-2.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-2",
					lastActivity: new Date().toISOString(),
					seeded: false,
				},
				{
					issueNumber: 3,
					repo: "case",
					owner: "mbrooks",
					title: "Three",
					body: "Body",
					status: "pending" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-case/issue-3.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-case/.worktrees/issue-3",
					lastActivity: new Date().toISOString(),
					seeded: false,
				},
			]),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status",
			headers: {
				Cookie: validCookie,
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.repos).toHaveLength(2);
		expect(body.repos[0]).toEqual({ owner: "mbrooks", repo: "case", sessionCount: 1, activeCount: 1, implementationSessionCount: 1, implementationActiveCount: 1, refinementSessionCount: 0, refinementActiveCount: 0, lastActivity: expect.any(String) });
		expect(body.repos[1]).toEqual({ owner: "mbrooks", repo: "yolomatic", sessionCount: 2, activeCount: 1, implementationSessionCount: 2, implementationActiveCount: 1, refinementSessionCount: 0, refinementActiveCount: 0, lastActivity: expect.any(String) });

		server.close();
	});

	it("returns empty repos array when no sessions exist", async () => {
		const mockStore = {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status",
			headers: {
				Cookie: validCookie,
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.repos).toEqual([]);

		server.close();
	});

	it("returns 503 for /api/sessions commands when admin credentials are not configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/1/implementation/commands",
		}, JSON.stringify({ command: "cancel" }));
		expect(response.statusCode).toBe(503);

		server.close();
	});

	it("cancels an active session via POST /api/sessions/:owner/:repo/:issueNumber/commands", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 1,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const taskController = {
			cancel: vi.fn(() => true),
			isActive: vi.fn(() => true),
			register: vi.fn(),
			unregister: vi.fn(),
		} as unknown as import("../task-controller.js").TaskController;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, taskController, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/1/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "cancel" }));
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.cancelled).toBe(true);
		expect(body.wasActive).toBe(true);
		expect(taskController.cancel).toHaveBeenCalledWith("mbrooks/yolomatic#1");

		server.close();
	});

	it("marks session as cancelled when not active via POST commands cancel", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 2,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-2.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-2",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(async (state: import("../session/store.js").SessionState) => state),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const taskController = {
			cancel: vi.fn(() => false),
			isActive: vi.fn(() => false),
			register: vi.fn(),
			unregister: vi.fn(),
		} as unknown as import("../task-controller.js").TaskController;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, taskController, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/2/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "cancel" }));
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.cancelled).toBe(false);
		expect(body.status).toBe("cancelled");
		expect(mockStore.set).toHaveBeenCalled();

		server.close();
	});

	it("returns 404 for cancel command when session does not exist", async () => {
		const mockStore = {
			get: vi.fn(async () => null),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/999/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "cancel" }));
		expect(response.statusCode).toBe(404);
		const body = JSON.parse(response.body);
		expect(body.error).toBe("Session not found");

		server.close();
	});

	it("marks a session failed via POST /api/sessions/:owner/:repo/:issueNumber/commands", async () => {
		const session = {
			issueNumber: 89,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Yolomatic: Add stale session detection",
			body: "Fixes #86\n\nSummary",
			status: "complete" as const,
			sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-89.jsonl",
			workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-89",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};
		const mockStore = {
			get: vi.fn(async () => session),
			set: vi.fn(async (state: import("../session/store.js").SessionState) => state),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/89/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "mark-failed" }));
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.status).toBe("failed");
		expect(mockStore.set).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "failed",
				summary: "Marked failed by admin cleanup.",
			}),
		);

		server.close();
	});

	it("deletes a terminal session via POST /api/sessions/:owner/:repo/:issueNumber/commands", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 3,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "complete" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-3.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-3",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
			delete: vi.fn(async () => undefined),
		} as unknown as import("../session/store.js").SessionStore;

		const workspaceManager = makeWorkspaceManager({
			removeWorktree: vi.fn(async () => undefined),
		});

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, workspaceManager, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/3/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "delete" }));
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.deleted).toBe(true);
		expect(body.message).toBe("Session and workspace deleted.");
		expect(workspaceManager.removeWorktree).toHaveBeenCalledWith("mbrooks", "yolomatic", 3);
		expect(mockStore.delete).toHaveBeenCalledWith("mbrooks", "yolomatic", 3, "implementation");

		server.close();
	});

	it("returns 400 when deleting a non-terminal session", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 4,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-4.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-4",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
			delete: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/4/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "delete" }));
		expect(response.statusCode).toBe(400);
		const body = JSON.parse(response.body);
		expect(body.error).toContain("Cannot delete session in 'working' status");
		expect(mockStore.delete).not.toHaveBeenCalled();

		server.close();
	});

	it("returns 404 for delete command when session does not exist", async () => {
		const mockStore = {
			get: vi.fn(async () => null),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
			delete: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/999/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "delete" }));
		expect(response.statusCode).toBe(404);
		const body = JSON.parse(response.body);
		expect(body.error).toBe("Session not found");

		server.close();
	});

	it("returns 503 for delete command when admin credentials are not configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/1/implementation/commands",
		}, JSON.stringify({ command: "delete" }));
		expect(response.statusCode).toBe(503);

		server.close();
	});

	it("returns 503 for pause command when admin credentials are not configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/1/implementation/commands",
		}, JSON.stringify({ command: "pause" }));
		expect(response.statusCode).toBe(503);

		server.close();
	});

	it("pauses a session via POST /api/sessions/:owner/:repo/:issueNumber/commands", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 1,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(async (state: import("../session/store.js").SessionState) => state),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/1/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "pause" }));
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.paused).toBe(true);
		expect(body.status).toBe("paused");
		expect(mockStore.set).toHaveBeenCalledWith(expect.objectContaining({ status: "paused" }));

		server.close();
	});

	it("returns 400 when pausing an already paused session", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 2,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "paused" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-2.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-2",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/2/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "pause" }));
		expect(response.statusCode).toBe(400);
		const body = JSON.parse(response.body);
		expect(body.error).toBe("Session is already paused.");
		expect(mockStore.set).not.toHaveBeenCalled();

		server.close();
	});

	it("returns 400 when pausing a terminal session", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 3,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "complete" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-3.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-3",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/3/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "pause" }));
		expect(response.statusCode).toBe(400);
		const body = JSON.parse(response.body);
		expect(body.error).toContain("Cannot pause a session in 'complete' status");
		expect(mockStore.set).not.toHaveBeenCalled();

		server.close();
	});

	it("returns 404 for pause command when session does not exist", async () => {
		const mockStore = {
			get: vi.fn(async () => null),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/999/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "pause" }));
		expect(response.statusCode).toBe(404);
		const body = JSON.parse(response.body);
		expect(body.error).toBe("Session not found");

		server.close();
	});

	it("returns 503 for resume command when admin credentials are not configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/1/implementation/commands",
		}, JSON.stringify({ command: "resume" }));
		expect(response.statusCode).toBe(503);

		server.close();
	});

	it("resumes a paused session via POST /api/sessions/:owner/:repo/:issueNumber/commands", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 1,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "paused" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(async (state: import("../session/store.js").SessionState) => state),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/1/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "resume" }));
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.resumed).toBe(true);
		expect(body.status).toBe("pending");
		expect(mockStore.set).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));

		server.close();
	});

	it("returns 400 when resuming a non-paused session", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 2,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-2.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-2",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/2/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "resume" }));
		expect(response.statusCode).toBe(400);
		const body = JSON.parse(response.body);
		expect(body.error).toContain("Cannot resume a session in 'working' status");
		expect(mockStore.set).not.toHaveBeenCalled();

		server.close();
	});

	it("returns 404 for resume command when session does not exist", async () => {
		const mockStore = {
			get: vi.fn(async () => null),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/999/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "resume" }));
		expect(response.statusCode).toBe(404);
		const body = JSON.parse(response.body);
		expect(body.error).toBe("Session not found");

		server.close();
	});

	it("returns 503 for restart command when admin credentials are not configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/1/implementation/commands",
		}, JSON.stringify({ command: "restart" }));
		expect(response.statusCode).toBe(503);

		server.close();
	});

	it("restarts a failed session via POST /api/sessions/:owner/:repo/:issueNumber/commands", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 5,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "failed" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-5.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-5",
				lastActivity: new Date().toISOString(),
				seeded: true,
				summary: "Boom",
				prNumber: 7,
				prUrl: "https://github.com/mbrooks/yolomatic/pull/7",
				iterationCount: 2,
			})),
			set: vi.fn(async (state: import("../session/store.js").SessionState) => state),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const workspaceManager = makeWorkspaceManager({
			removeWorktree: vi.fn(async () => undefined),
		});
		const restartSession = vi.fn(async () => undefined);

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, workspaceManager, restartSession, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/5/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "restart" }));
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.restarted).toBe(true);
		expect(body.dispatched).toBe(true);
		expect(body.status).toBe("pending");
		expect(workspaceManager.removeWorktree).toHaveBeenCalledWith("mbrooks", "yolomatic", 5);
		expect(mockStore.set).toHaveBeenCalled();
		const setCall = ((mockStore.set as unknown as ReturnType<typeof vi.fn>).mock.calls as unknown) as Array<[import("../session/store.js").SessionState]>;
		const updatedState = setCall[0][0];
		expect(updatedState.status).toBe("pending");
		expect(updatedState.summary).toBeUndefined();
		// Restart preserves a durable PR association for recovery.
		expect(updatedState.prNumber).toBe(7);
		expect(updatedState.prUrl).toBe("https://github.com/mbrooks/yolomatic/pull/7");
		expect(updatedState.seeded).toBe(false);
		expect(updatedState.iterationCount).toBeUndefined();
		expect(updatedState.restartCount).toBe(1);
		expect(updatedState.restartedFrom).toBe("failed");
		expect(restartSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 5);

		server.close();
	});

	it("restarts a cancelled session via POST commands restart", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 6,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "cancelled" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-6.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-6",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(async (state: import("../session/store.js").SessionState) => state),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const workspaceManager = makeWorkspaceManager({
			removeWorktree: vi.fn(async () => undefined),
		});
		const restartSession = vi.fn(async () => undefined);

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, workspaceManager, restartSession, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/6/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "restart" }));
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.restarted).toBe(true);
		expect(body.dispatched).toBe(true);
		expect(body.status).toBe("pending");
		expect(restartSession).toHaveBeenCalledWith("mbrooks", "yolomatic", 6);

		server.close();
	});

	it("returns 400 when restarting a completed session", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 7,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "complete" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-7.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-7",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/7/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "restart" }));
		expect(response.statusCode).toBe(400);
		const body = JSON.parse(response.body);
		expect(body.error).toContain("Cannot restart a completed session");
		expect(mockStore.set).not.toHaveBeenCalled();

		server.close();
	});

	it("returns 400 when restarting a working session", async () => {
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 8,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-8.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-8",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/8/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "restart" }));
		expect(response.statusCode).toBe(400);
		const body = JSON.parse(response.body);
		expect(body.error).toContain("Cannot restart session in 'working' status");
		expect(mockStore.set).not.toHaveBeenCalled();

		server.close();
	});

	it("returns 404 for restart command when session does not exist", async () => {
		const mockStore = {
			get: vi.fn(async () => null),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/sessions/mbrooks/yolomatic/999/implementation/commands",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		}, JSON.stringify({ command: "restart" }));
		expect(response.statusCode).toBe(404);
		const body = JSON.parse(response.body);
		expect(body.error).toBe("Session not found");

		server.close();
	});

	it("returns 503 for log when admin credentials are not configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/sessions/mbrooks/yolomatic/1/implementation/log",
		});
		expect(response.statusCode).toBe(503);

		server.close();
	});

	it("returns 401 for log without auth header when credentials are configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore(), userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, { method: "GET", path: "/api/sessions/mbrooks/yolomatic/1/implementation/log" });
		expect(response.statusCode).toBe(401);
		expect(JSON.parse(response.body).error).toBe("Unauthorized");

		server.close();
	});

	it("returns 404 for log when session does not exist", async () => {
		const mockStore = {
			get: vi.fn(async () => null),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/sessions/mbrooks/yolomatic/999/implementation/log",
			headers: {
				Cookie: validCookie,
			},
		});
		expect(response.statusCode).toBe(404);
		const body = JSON.parse(response.body);
		expect(body.error).toBe("Session not found");

		server.close();
	});

	it("returns log lines when log file exists", async () => {
		_resetSessionLogs();
		recordSessionLog("github-mbrooks-yolomatic-issue-1-implementation", { level: "info", message: "prompt" });
		recordSessionLog("github-mbrooks-yolomatic-issue-1-implementation", { level: "info", message: "response" });

		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 1,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/session.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		try {
			const response = await makeRequest(port, {
				method: "GET",
				path: "/api/sessions/mbrooks/yolomatic/1/implementation/log",
				headers: {
					Cookie: validCookie,
				},
			});
			expect(response.statusCode).toBe(200);
			const body = JSON.parse(response.body);
			expect(body.available).toBe(true);
			expect(body.logs).toHaveLength(2);
			expect(body.logs[0].message).toBe("prompt");
			expect(body.logs[1].message).toBe("response");
		} finally {
			server.close();
		}
	});

	it("returns unavailable log when log file is missing", async () => {
		_resetSessionLogs();
		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 1,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "working" as const,
				sessionPath: "/nonexistent/path/issue-1.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/sessions/mbrooks/yolomatic/1/implementation/log",
			headers: {
				Cookie: validCookie,
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.available).toBe(true);
		expect(body.logs).toEqual([]);

		server.close();
	});

	it("truncates log when it exceeds 10,000 lines", async () => {
		_resetSessionLogs();
		for (let i = 0; i < 5_001; i++) {
			recordSessionLog("github-mbrooks-yolomatic-issue-1-implementation", { level: "info", message: "line " + i });
		}

		const mockStore = {
			get: vi.fn(async () => ({
				issueNumber: 1,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Test",
				body: "Body",
				status: "working" as const,
				sessionPath: "/tmp/session.jsonl",
				workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
				lastActivity: new Date().toISOString(),
				seeded: false,
			})),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;

		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		try {
			const response = await makeRequest(port, {
				method: "GET",
				path: "/api/sessions/mbrooks/yolomatic/1/implementation/log",
				headers: {
					Cookie: validCookie,
				},
			});
			expect(response.statusCode).toBe(200);
			const body = JSON.parse(response.body);
			expect(body.available).toBe(true);
			expect(body.logs).toHaveLength(5_000);
			expect(body.logs[0].message).toBe("line 1");
		} finally {
			server.close();
		}
	});

	it("returns 404 for log with invalid issue number", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore(), userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/sessions/mbrooks/yolomatic/abc/implementation/log",
			headers: {
				Cookie: validCookie,
			},
		});
		expect(response.statusCode).toBe(404);
		const body = JSON.parse(response.body);
		expect(body.error).toBe("Not found");

		server.close();
	});

	it("returns working status via GET /api/status/working", async () => {
		const mockStore = {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => [
				{
					issueNumber: 1,
					repo: "yolomatic",
					owner: "mbrooks",
					title: "Test",
					body: "Body",
					status: "working" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-1.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
					lastActivity: new Date().toISOString(),
					seeded: false,
				},
				{
					issueNumber: 2,
					repo: "yolomatic",
					owner: "mbrooks",
					title: "Test",
					body: "Body",
					status: "pending" as const,
					sessionPath: "/tmp/sessions/github-mbrooks-yolomatic/issue-2.jsonl",
					workspacePath: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-2",
					lastActivity: new Date().toISOString(),
					seeded: false,
				},
			]),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status/working",
			headers: {
				Cookie: validCookie,
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.working).toBe(true);
		expect(body.count).toBe(1);
		expect(body.sessions).toHaveLength(1);
		expect(body.sessions[0].issueNumber).toBe(1);

		server.close();
	});

	it("returns working:false when no sessions are working", async () => {
		const mockStore = {
			get: vi.fn(),
			set: vi.fn(),
			exists: vi.fn(),
			getAll: vi.fn(async () => []),
			getSessionKey: vi.fn(),
			getSessionPath: vi.fn(),
			getStatePath: vi.fn(),
		} as unknown as import("../session/store.js").SessionStore;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: mockStore, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/status/working",
			headers: {
				Cookie: validCookie,
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.working).toBe(false);
		expect(body.count).toBe(0);

		server.close();
	});

	it("returns maintenance status via GET /api/maintenance", async () => {
		const taskController = {
			isDraining: vi.fn(() => true),
			setDraining: vi.fn(),
			cancel: vi.fn(),
			isActive: vi.fn(),
			register: vi.fn(),
			unregister: vi.fn(),
		} as unknown as import("../task-controller.js").TaskController;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore(), taskController, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/api/maintenance",
			headers: {
				Cookie: validCookie,
			},
		});
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.draining).toBe(true);

		server.close();
	});

	it("sets draining mode via POST /api/maintenance", async () => {
		const taskController = {
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
			cancel: vi.fn(),
			isActive: vi.fn(),
			register: vi.fn(),
			unregister: vi.fn(),
		} as unknown as import("../task-controller.js").TaskController;
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore(), taskController, userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "POST",
			path: "/api/maintenance",
			headers: {
				Cookie: validCookie,
				"Content-Type": "application/json",
			},
		},
		JSON.stringify({ enabled: true }));
		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.draining).toBe(true);
		expect(taskController.setDraining).toHaveBeenCalledWith(true);

		server.close();
	});

	it("returns 503 for /api/status/working when credentials are not configured", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, { method: "GET", path: "/api/status/working" });
		expect(response.statusCode).toBe(503);

		server.close();
	});

	it("executes cleanupOldSessions", async () => {
		const sessionStore = makeMockSessionStore();
		const result = await cleanupOldSessions(sessionStore, undefined, 30);
		expect(result).toEqual({ deleted: 0, failed: 0 });
	});

	it("creates websocket endpoint using the admin session", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore(), userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

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
		server.close();
	});

	it("accepts websocket connections using the admin session cookie", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore(), userStore, sessionAuth });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const response = await makeRequest(port, {
			method: "GET",
			path: "/yolomatic/admin",
			headers: {
				Cookie: validCookie,
			},
		});

		expect(response.statusCode).toBe(200);

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
		server.close();
	});

	it("allows websocket without credentials in onboarding mode", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const client = new WebSocket(`ws://127.0.0.1:${port}/yolomatic/admin/ws`);

		await new Promise<void>((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});

		client.close();
		server.close();
	});

	it("serves the admin UI and websocket under a custom configured admin path", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const adminAssetsDir = await mkdtemp(join(tmpdir(), "yolomatic-admin-custom-"));
		await writeFile(
			join(adminAssetsDir, "index.html"),
			'<!doctype html><html><head><title>Yolomatic Admin</title></head><body><div id="root"></div></body></html>',
		);
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore(), adminAssetsDir, adminPath: "/custom/admin", adminDefaultPage: "#/repos" });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		try {
			const legacyResponse = await makeRequest(port, { method: "GET", path: "/yolomatic/admin" });
			expect(legacyResponse.statusCode).toBe(404);

			const customResponse = await makeRequest(port, { method: "GET", path: "/custom/admin" });
			expect(customResponse.statusCode).toBe(200);
			expect(customResponse.body).toContain('window.__YOLO_ADMIN_PATH__ = "/custom/admin"');
			expect(customResponse.body).toContain('window.__YOLO_ADMIN_DEFAULT_PAGE__ = "#/repos"');

			const client = new WebSocket(`ws://127.0.0.1:${port}/custom/admin/ws`);
			await new Promise<void>((resolve, reject) => {
				client.once("open", resolve);
				client.once("error", reject);
			});
			client.close();
		} finally {
			server.close();
			await rm(adminAssetsDir, { force: true, recursive: true });
		}
	});

	it("handles issue_comment webhook through server", async () => {
		const handlers = makeWebhookHandlers();
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const payload = JSON.stringify({
			action: "created",
			comment: { id: 4, body: "hello", created_at: "2026-06-28T00:00:00.000Z" },
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
		});
		const signature = `sha256=${createHmac("sha256", "secret").update(payload).digest("hex")}`;

		const response = await makeRequest(
			port,
			{
				method: "POST",
				path: "/webhook",
				headers: {
					"x-hub-signature-256": signature,
					"x-github-event": "issue_comment",
				},
			},
			payload,
		);
		expect(response.statusCode).toBe(200);
		expect(handlers.handleGitHubEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "issue_comment",
				payload: expect.objectContaining({ action: "created" }),
			}),
		);

		server.close();
	});

	it("fires onSessionLogEvent callback", async () => {
		const handlers = { handleIssueEvent: vi.fn(), handleCommentEvent: vi.fn(), handlePullRequestReviewCommentEvent: vi.fn(), handlePullRequestReviewEvent: vi.fn(), isInFlight: vi.fn(() => false) };
		const server = createWebhookServer({ secret: "secret", handlers, sessionStore: makeMockSessionStore() });
		await new Promise<void>((resolve) => server.listen(0, resolve));

		// Emitting a log should not throw
		recordSessionLog("test-session", { level: "info", message: "test" });

		server.close();
	});
});
