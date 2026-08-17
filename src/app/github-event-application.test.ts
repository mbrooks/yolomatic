import { describe, expect, it, vi } from "vitest";

import { createGitHubEventApplication } from "./github-event-application.js";
import { GitHubIssueHandlers } from "../webhook/handlers.js";
import { makeExecutor, makeSessionManager, makeWorkspaceManager } from "../webhook/handlers-test-helpers.js";
import type { GitHubService } from "../ports/github-service.js";
import type { TaskControlService, TaskRegistration } from "../ports/task-control-service.js";
import type { GitHubEvent } from "../github-events/model.js";

/**
 * Permissive {@link GitHubService} double. The factory-wiring tests exercise
 * paths that either do not reach GitHub or only need a no-op stand-in, so a
 * Proxy that lazily returns `vi.fn(async () => undefined)` for any method is
 * enough to satisfy the typed port without hand-stubbing every member.
 */
function makeFakeGitHubService(): GitHubService {
	const store: Record<string, unknown> = {};
	return new Proxy(store, {
		get(target, prop: string) {
			if (!(prop in target)) {
				target[prop] = vi.fn(async () => undefined);
			}
			return target[prop];
		},
	}) as unknown as GitHubService;
}

function makeFakeTaskController(overrides: Partial<TaskControlService> = {}): TaskControlService {
	return {
		cancel: vi.fn(() => false),
		isActive: vi.fn(() => false),
		steer: vi.fn(async () => false),
		register: vi.fn((): TaskRegistration | null => null),
		unregister: vi.fn(),
		isDraining: vi.fn(() => false),
		setDraining: vi.fn(),
		...overrides,
	};
}

function makeApplication(overrides: Partial<ReturnType<typeof baseDeps>> = {}): GitHubIssueHandlers {
	return createGitHubEventApplication({ ...baseDeps(), ...overrides });
}

function baseDeps() {
	return {
		sessions: makeSessionManager(),
		workspaces: makeWorkspaceManager(),
		executor: makeExecutor(),
		github: makeFakeGitHubService(),
		tasks: makeFakeTaskController(),
		githubUsername: "yolomatic-bot",
		selfReportEnabled: true,
	};
}

function makeIssueEvent(overrides: Partial<GitHubEvent["payload"]> = {}): GitHubEvent {
	return {
		id: `evt-${Math.random().toString(36).slice(2)}`,
		type: "issue",
		source: "webhook",
		owner: "mbrooks",
		repo: "yolomatic",
		occurredAt: new Date().toISOString(),
		payload: {
			action: "edited",
			issue: {
				number: 56,
				title: "New title",
				body: "New body",
				labels: [{ name: "yolomatic-working" }],
				assignees: [{ login: "yolomatic-bot" }],
				user: { login: "mbrooks" },
			},
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "mbrooks" },
			...overrides,
		} as never,
	};
}

describe("createGitHubEventApplication", () => {
	it("returns a GitHubIssueHandlers wired for event dispatch, resume, and in-flight lookup", () => {
		const handlers = makeApplication();
		expect(handlers).toBeInstanceOf(GitHubIssueHandlers);
		expect(typeof handlers.handleGitHubEvent).toBe("function");
		expect(typeof handlers.resumeInterruptedSession).toBe("function");
		expect(typeof handlers.restartRefinement).toBe("function");
		expect(typeof handlers.isInFlight).toBe("function");
	});

	it("dispatches issue events through the wired HandleIssueEvent command", async () => {
		const sessions = makeSessionManager({
			getSession: vi.fn(async () => ({
				kind: "implementation",
				issueNumber: 56,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Title",
				body: "Old body",
				status: "working",
				sessionPath: "/tmp/s.jsonl",
				workspacePath: "/tmp/w",
				lastActivity: new Date().toISOString(),
				seeded: true,
			})),
			updateStatus: vi.fn(async (_o, _r, _n, status) => ({
				kind: "implementation",
				issueNumber: 56,
				repo: "yolomatic",
				owner: "mbrooks",
				title: "Title",
				body: "New body",
				status,
				sessionPath: "/tmp/s.jsonl",
				workspacePath: "/tmp/w",
				lastActivity: new Date().toISOString(),
				seeded: true,
			})),
		});
		const tasks = makeFakeTaskController({ isActive: vi.fn(() => false) });
		const handlers = makeApplication({ sessions, tasks });

		await handlers.handleGitHubEvent(makeIssueEvent());

		expect(sessions.get).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, "implementation");
		expect(sessions.updateStatus).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			56,
			"working",
			expect.objectContaining({ body: "New body", title: "New title" }),
		);
	});

	it("wires resumeInterruptedSession through the ResumeInterruptedSession command", async () => {
		const sessions = makeSessionManager({
			getSession: vi.fn(async () => null),
		});
		const handlers = makeApplication({ sessions });

		await handlers.resumeInterruptedSession("mbrooks", "yolomatic", 56);

		expect(sessions.get).toHaveBeenCalledWith("mbrooks", "yolomatic", 56, "implementation");
	});

	it("wires restartRefinement through the HandleIssueRefinement command", async () => {
		const refinementStore = {
			getLatestAttempt: vi.fn(() => null),
		} as unknown as import("../refinement/store.js").RefinementStore;
		const handlers = makeApplication({ refinementStore } as never);

		await expect(handlers.restartRefinement("mbrooks", "yolomatic", 56)).rejects.toThrow(
			"No refinement attempt exists",
		);
		expect(refinementStore.getLatestAttempt).toHaveBeenCalledWith("mbrooks", "yolomatic", 56);
	});

	it("delegates isInFlight to the wired HandleIssueEvent command", () => {
		const handlers = makeApplication();
		expect(handlers.isInFlight("mbrooks", "yolomatic", 56)).toBe(false);
	});

	it("gates webhook events through the injected resolveGitHubEventMode resolver", async () => {
		const sessions = makeSessionManager({
			getSession: vi.fn(async () => null),
		});
		const handlers = createGitHubEventApplication({
			...baseDeps(),
			sessions,
			resolveGitHubEventMode: () => "polling",
		});

		await handlers.handleGitHubEvent(makeIssueEvent());

		// Polling-only mode must drop webhook events before reaching commands.
		expect(sessions.get).not.toHaveBeenCalled();
	});

	it("marks an issue in-flight during resumeInterruptedSession", async () => {
		const sessions = makeSessionManager({
			getSession: vi.fn(async () => null),
		});
		const handlers = makeApplication({ sessions });

		let observed = false;
		sessions.get.mockImplementationOnce(async () => {
			observed = handlers.isInFlight("mbrooks", "yolomatic", 56);
			return null;
		});

		await handlers.resumeInterruptedSession("mbrooks", "yolomatic", 56);

		expect(observed).toBe(true);
		expect(handlers.isInFlight("mbrooks", "yolomatic", 56)).toBe(false);
	});
});