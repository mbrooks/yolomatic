import { describe, expect, it, vi } from "vitest";

// dotenv/config side effect must be suppressed before index.ts is loaded
vi.mock("dotenv/config", () => ({}));

vi.mock("./config.js", () => ({
	getConfig: vi.fn(() => ({
		port: 3000,
		autoStart: true,
		webhookSecret: "secret",
		sessionsDir: "/tmp/sessions",
		defaultBranch: "main",
		githubToken: "token",
		githubUsername: "tars-bot",
		workspacesDir: "/tmp/workspaces",
		soulPath: "/tmp/SOUL.md",
		maxIterations: 3,
		selfReportEnabled: true,
	})),
}));

vi.mock("./session/store.js", () => ({
	SessionStore: vi.fn(() => ({
		get: vi.fn(),
		set: vi.fn(),
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
		commitAndPush: vi.fn(),
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

describe("main", () => {
	it("creates webhook server and listens on configured port", async () => {
		await main();
		expect(createWebhookServer).toHaveBeenCalledWith("secret", expect.any(Object));
		const server = (createWebhookServer as ReturnType<typeof vi.fn>).mock.results[0]?.value;
		expect(server.listen).toHaveBeenCalledWith(3000, expect.any(Function));
	});
});
