import { describe, expect, it, vi } from "vitest";

// dotenv/config side effect must be suppressed before index.ts is loaded
vi.mock("dotenv/config", () => ({}));

vi.mock("./config.js", () => ({
	getConfig: vi.fn(() => ({
		port: 3000,
		autoStart: true,
		webhookSecret: "secret",
		sessionsDir: "/tmp/sessions",
		archiveDir: "/tmp/sessions/archive",
		defaultBranch: "main",
		githubToken: "token",
		githubUsername: "tars-bot",
		workspacesDir: "/tmp/workspaces",
		soulPath: "/tmp/SOUL.md",
		maxIterations: 3,
		selfReportEnabled: true,
		adminUsername: "admin",
		adminPassword: "secret",
		adminGithubUsername: "admin",
		cleanupRetentionDays: undefined,
		staleThresholdMs: 14400000,
		maxWorktrees: 10,
		evictionStrategy: "lru",
	})),
}));

vi.mock("./session/store.js", () => ({
	SessionStore: vi.fn(() => ({
		get: vi.fn(),
		set: vi.fn(),
		getAll: vi.fn(async () => []),
	})),
}));

vi.mock("./session/manager.js", () => ({
	SessionManager: vi.fn(() => ({
		getSessionKey: vi.fn(),
		getSessionPath: vi.fn(),
		createSession: vi.fn(),
		getSession: vi.fn(),
		resumeSession: vi.fn(),
		updateStatus: vi.fn(),
		markSeeded: vi.fn(),
	})),
}));

vi.mock("./workspace/manager.js", () => ({
	WorkspaceManager: vi.fn(() => ({
		createOrGetWorktree: vi.fn(),
		commitAndPush: vi.fn(async () => true),
		removeWorktree: vi.fn(),
	})),
}));

vi.mock("./executor/index.js", () => ({
	PiAgentExecutor: vi.fn(() => ({
		execute: vi.fn(),
	})),
}));

vi.mock("./webhook/handlers.js", () => ({
	GitHubIssueHandlers: vi.fn(() => ({
		handleIssueEvent: vi.fn(),
		handleCommentEvent: vi.fn(),
		handlePullRequestReviewCommentEvent: vi.fn(),
		handlePullRequestReviewEvent: vi.fn(),
		isInFlight: vi.fn(() => false),
		resumeInterruptedSession: vi.fn(),
	})),
}));

vi.mock("./webhook/server.js", () => ({
	createWebhookServer: vi.fn(() => ({
		listen: vi.fn((port, cb) => {
			if (typeof cb === "function") cb();
			return { close: vi.fn() };
		}),
	})),
}));

import { createWebhookServer } from "./webhook/server.js";
import { main } from "./index.js";
import { GitHubIssueHandlers } from "./webhook/handlers.js";
import { SessionStore } from "./session/store.js";

describe("main", () => {
	it("creates webhook server and listens on configured port", async () => {
		await main();
		expect(createWebhookServer).toHaveBeenCalledWith("secret", expect.any(Object), expect.any(Object), "admin", "secret", expect.any(Object), expect.any(Object), expect.any(Object), expect.any(String));
		const server = (createWebhookServer as ReturnType<typeof vi.fn>).mock.results[0]?.value;
		expect(server.listen).toHaveBeenCalledWith(3000, expect.any(Function));
	});

	it("resumes interrupted working sessions on startup", async () => {
		const mockGetAll = vi.fn(async () => [
			{
				owner: "mbrooks",
				repo: "tars",
				issueNumber: 42,
				status: "working",
				workspacePath: "/tmp/ws",
				title: "Title",
				body: "Body",
				lastActivity: new Date().toISOString(),
				seeded: false,
			},
		]);
		(SessionStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
			get: vi.fn(),
			set: vi.fn(),
			getAll: mockGetAll,
		}));
		await main();
		const mockFn = GitHubIssueHandlers as unknown as ReturnType<typeof vi.fn>;
		const handlersInstance = mockFn.mock.results[mockFn.mock.results.length - 1]?.value;
		expect(handlersInstance.resumeInterruptedSession).toHaveBeenCalledWith("mbrooks", "tars", 42);
	});
});
