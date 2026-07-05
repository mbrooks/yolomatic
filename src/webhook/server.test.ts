import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GitHubEvent } from "../github-events/model.js";

const sendText = vi.fn();
const handleAdminRoute = vi.fn(async () => false);
const readBody = vi.fn(async () => Buffer.from("{}"));
const verifySignature = vi.fn(() => true);
const createWebhookServerDeps = vi.fn();
const createAdminWebSocketServer = vi.fn();
const onSessionLogEvent = vi.fn();

function makeHandlers() {
	return {
		handleGitHubEvent: vi.fn(async (_event: GitHubEvent) => {}),
		isInFlight: vi.fn(() => false),
	};
}

let capturedRequestHandler: ((request: any, response: any) => Promise<void>) | null = null;
let closeCallback: ((error?: Error) => void) | undefined;
const fakeServer = {
	close: vi.fn((callback?: (error?: Error) => void) => {
		closeCallback = callback;
		return fakeServer;
	}),
};

vi.mock("node:http", async () => ({
	createServer: vi.fn((handler: (request: any, response: any) => Promise<void>) => {
		capturedRequestHandler = handler;
		return fakeServer;
	}),
}));

vi.mock("../adapters/http/response-helpers.js", () => ({
	sendText,
}));

vi.mock("../adapters/http/admin-router.js", () => ({
	handleAdminRoute,
}));

vi.mock("./http-utils.js", () => ({
	readBody,
	verifySignature,
}));

vi.mock("./server-deps.js", () => ({
	createWebhookServerDeps,
}));

vi.mock("./websocket-server.js", () => ({
	createAdminWebSocketServer,
}));

vi.mock("../logging/log-events.js", () => ({
	onSessionLogEvent,
}));

describe("createWebhookServer", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		capturedRequestHandler = null;
		closeCallback = undefined;
		createWebhookServerDeps.mockImplementation(
			(
				_sessionStore: unknown,
				adminUsername?: string,
				adminPassword?: string,
				_taskController?: unknown,
				_workspaceManager?: unknown,
				_staleDetector?: unknown,
				_archiveDir?: unknown,
				_adminAssetsDir?: unknown,
				_githubService?: unknown,
				settingsStore?: unknown,
				_executor?: unknown,
			) => ({
				adminUsername,
				adminPassword,
				settingsStore: settingsStore ?? {
					get: vi.fn((key: string) => {
						if (key === "admin_username") return "stored-admin";
						if (key === "admin_password") return "stored-secret";
						return undefined;
					}),
				},
				getAdminStatus: {
					execute: vi.fn(async () => ({ success: true, data: { agent: "online" } })),
				},
			}),
		);
		createAdminWebSocketServer.mockReturnValue({
			broadcastLog: vi.fn(),
			broadcastStatus: vi.fn(),
			close: vi.fn(async () => {}),
		});
		onSessionLogEvent.mockReturnValue(vi.fn());
	});

	it("passes explicit admin credentials and status provider to the websocket server", async () => {
		const { createWebhookServer } = await import("./server.js");
		createWebhookServer("secret", {} as never, {} as never, "admin", "secret");

		const [, credentialProvider, statusProvider] = createAdminWebSocketServer.mock.calls[0];
		expect(credentialProvider.getCredentials()).toEqual({ username: "admin", password: "secret" });
		await expect(statusProvider.getStatus()).resolves.toEqual({ agent: "online" });
	});

	it("falls back to settings-store credentials when env credentials are absent", async () => {
		createWebhookServerDeps.mockReturnValue({
			adminUsername: undefined,
			adminPassword: undefined,
			settingsStore: {
				get: vi.fn((key: string) => {
					if (key === "admin_username") return "stored-admin";
					if (key === "admin_password") return "stored-secret";
					return undefined;
				}),
			},
			getAdminStatus: {
				execute: vi.fn(async () => ({ success: true, data: { agent: "online" } })),
			},
		});

		const { createWebhookServer } = await import("./server.js");
		createWebhookServer("secret", {} as never, {} as never);

		const [, credentialProvider] = createAdminWebSocketServer.mock.calls[0];
		expect(credentialProvider.getCredentials()).toEqual({
			username: "stored-admin",
			password: "stored-secret",
		});
	});

	it("returns 404 for non-webhook requests when admin routes do not handle them", async () => {
		const { createWebhookServer } = await import("./server.js");
		createWebhookServer("secret", {} as never, {} as never);

		await capturedRequestHandler?.(
			{ method: "GET", url: "/nope", headers: {} },
			{},
		);

		expect(sendText).toHaveBeenCalledWith({}, 404, "Not found");
	});

	it("short-circuits when an admin route handles the request", async () => {
		handleAdminRoute.mockResolvedValueOnce(true);
		const { createWebhookServer } = await import("./server.js");
		createWebhookServer("secret", {} as never, {} as never);

		await capturedRequestHandler?.(
			{ method: "GET", url: "/api/status", headers: {} },
			{},
		);

		expect(sendText).not.toHaveBeenCalled();
	});

	it("routes signed issue_comment webhooks through the normalized dispatcher", async () => {
		const handlers = {
			handleGitHubEvent: vi.fn(async (_event: GitHubEvent) => {}),
			isInFlight: vi.fn(() => false),
		};
		readBody.mockResolvedValueOnce(
			Buffer.from('{"action":"created","comment":{"id":1,"created_at":"2026-06-28T00:00:00.000Z"},"repository":{"name":"tars","owner":{"login":"mbrooks"}}}'),
		);

		const { createWebhookServer } = await import("./server.js");
		createWebhookServer("secret", handlers as never, {} as never);

		await capturedRequestHandler?.(
			{
				method: "POST",
				url: "/webhook",
				headers: {
					"x-github-event": "issue_comment",
					"x-github-delivery": "delivery-1",
					"x-hub-signature-256": "sig",
				},
			},
			{},
		);

		expect(verifySignature).toHaveBeenCalled();
		expect(handlers.handleGitHubEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "issue_comment",
				owner: "mbrooks",
				repo: "tars",
				source: "webhook",
				payload: expect.objectContaining({ action: "created" }),
			}),
		);
		expect(sendText).toHaveBeenCalledWith({}, 200, "OK");
	});

	it("routes issues webhooks through the normalized dispatcher", async () => {
		const handlers = makeHandlers();
		readBody.mockResolvedValueOnce(
			Buffer.from('{"action":"opened","issue":{"number":12,"created_at":"2026-06-28T00:00:00.000Z"},"repository":{"name":"tars","owner":{"login":"mbrooks"}}}'),
		);

		const { createWebhookServer } = await import("./server.js");
		createWebhookServer("secret", handlers as never, {} as never);

		await capturedRequestHandler?.(
			{
				method: "POST",
				url: "/webhook",
				headers: {
					"x-github-event": "issues",
					"x-hub-signature-256": "sig",
				},
			},
			{},
		);

		expect(handlers.handleGitHubEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "issue",
				owner: "mbrooks",
				repo: "tars",
				source: "webhook",
				payload: expect.objectContaining({ action: "opened" }),
			}),
		);
		expect(sendText).toHaveBeenCalledWith({}, 200, "OK");
	});

	it("routes pull_request_review_comment webhooks through the normalized dispatcher", async () => {
		const handlers = makeHandlers();
		readBody.mockResolvedValueOnce(
			Buffer.from('{"action":"created","comment":{"id":2,"created_at":"2026-06-28T00:00:00.000Z"},"repository":{"name":"tars","owner":{"login":"mbrooks"}}}'),
		);

		const { createWebhookServer } = await import("./server.js");
		createWebhookServer("secret", handlers as never, {} as never);

		await capturedRequestHandler?.(
			{
				method: "POST",
				url: "/webhook",
				headers: {
					"x-github-event": "pull_request_review_comment",
					"x-hub-signature-256": "sig",
				},
			},
			{},
		);

		expect(handlers.handleGitHubEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "pull_request_review_comment",
				payload: expect.objectContaining({ action: "created" }),
			}),
		);
		expect(sendText).toHaveBeenCalledWith({}, 200, "OK");
	});

	it("routes pull_request_review webhooks through the normalized dispatcher", async () => {
		const handlers = makeHandlers();
		readBody.mockResolvedValueOnce(
			Buffer.from('{"action":"submitted","review":{"id":3,"submitted_at":"2026-06-28T00:00:00.000Z"},"repository":{"name":"tars","owner":{"login":"mbrooks"}}}'),
		);

		const { createWebhookServer } = await import("./server.js");
		createWebhookServer("secret", handlers as never, {} as never);

		await capturedRequestHandler?.(
			{
				method: "POST",
				url: "/webhook",
				headers: {
					"x-github-event": "pull_request_review",
					"x-hub-signature-256": "sig",
				},
			},
			{},
		);

		expect(handlers.handleGitHubEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "pull_request_review",
				payload: expect.objectContaining({ action: "submitted" }),
			}),
		);
		expect(sendText).toHaveBeenCalledWith({}, 200, "OK");
	});

	it("rejects invalid webhook signatures", async () => {
		verifySignature.mockReturnValueOnce(false);
		const { createWebhookServer } = await import("./server.js");
		createWebhookServer("secret", makeHandlers() as never, {} as never);

		await capturedRequestHandler?.(
			{
				method: "POST",
				url: "/webhook",
				headers: {
					"x-github-event": "issue_comment",
					"x-hub-signature-256": "bad",
				},
			},
			{},
		);

		expect(sendText).toHaveBeenCalledWith({}, 401, "Invalid signature");
	});

	it("ignores unsupported webhook events", async () => {
		readBody.mockResolvedValueOnce(Buffer.from('{"action":"noop"}'));
		const handlers = makeHandlers();
		const { createWebhookServer } = await import("./server.js");
		createWebhookServer("secret", handlers as never, {} as never);

		await capturedRequestHandler?.(
			{
				method: "POST",
				url: "/webhook",
				headers: {
					"x-github-event": "ping",
					"x-hub-signature-256": "sig",
				},
			},
			{},
		);

		expect(handlers.handleGitHubEvent).not.toHaveBeenCalled();
		expect(sendText).toHaveBeenCalledWith({}, 200, "OK");
	});

	it("returns 500 when a webhook handler throws", async () => {
		readBody.mockResolvedValueOnce(Buffer.from('{"action":"created"}'));
		const handlers = makeHandlers();
		handlers.handleGitHubEvent.mockRejectedValueOnce(new Error("boom"));
		const { createWebhookServer } = await import("./server.js");
		createWebhookServer("secret", handlers as never, {} as never);

		await capturedRequestHandler?.(
			{
				method: "POST",
				url: "/webhook",
				headers: {
					"x-github-event": "issue_comment",
					"x-hub-signature-256": "sig",
				},
			},
			{},
		);

		expect(sendText).toHaveBeenCalledWith({}, 500, "boom");
	});

	it("cleans up the websocket server and log subscription on close", async () => {
		const stopLogEvents = vi.fn();
		const wsClose = vi.fn(async () => {});
		const workerRpcClose = vi.fn(async () => {});
		const workerRpcAttach = vi.fn();
		onSessionLogEvent.mockReturnValue(stopLogEvents);
		createAdminWebSocketServer.mockReturnValue({
			broadcastLog: vi.fn(),
			broadcastStatus: vi.fn(),
			close: wsClose,
		});

		const { createWebhookServer } = await import("./server.js");
		const server = createWebhookServer(
			"secret",
			{} as never,
			{} as never,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{},
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ attach: workerRpcAttach, close: workerRpcClose } as never,
		);

		expect(workerRpcAttach).toHaveBeenCalledWith(fakeServer);

		server.close();
		expect(closeCallback).toBeTypeOf("function");
		closeCallback?.();
		await vi.waitFor(() => {
			expect(wsClose).toHaveBeenCalled();
			expect(workerRpcClose).toHaveBeenCalled();
		});

		expect(stopLogEvents).toHaveBeenCalled();
	});

	it("forwards session log events to the websocket server", async () => {
		const broadcastLog = vi.fn();
		createAdminWebSocketServer.mockReturnValue({
			broadcastLog,
			broadcastStatus: vi.fn(),
			close: vi.fn(async () => {}),
		});

		const { createWebhookServer } = await import("./server.js");
		createWebhookServer("secret", {} as never, {} as never);

		const logListener = onSessionLogEvent.mock.calls[0]?.[0];
		expect(logListener).toBeTypeOf("function");

		logListener?.("session-1", { message: "hello" });

		expect(broadcastLog).toHaveBeenCalledWith("session-1", { message: "hello" });
	});
});

describe("cleanupOldSessions", () => {
	it("delegates to the cleanup command", async () => {
		createWebhookServerDeps.mockReturnValue({
			cleanupCommand: {
				execute: vi.fn(async () => ({ deleted: 2, failed: 1 })),
			},
		});
		const { cleanupOldSessions } = await import("./server.js");
		await expect(cleanupOldSessions({} as never, undefined, 30)).resolves.toEqual({
			deleted: 2,
			failed: 1,
		});
	});
});
