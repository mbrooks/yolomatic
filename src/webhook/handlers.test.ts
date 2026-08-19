import { describe, expect, it, vi } from "vitest";

import { GitHubIssueHandlers } from "./handlers.js";
import type { GitHubEvent, GitHubEventSource } from "../github-events/model.js";
import type { RepoGitHubEventMode } from "../repos/repository.js";

/**
 * Build a {@link GitHubIssueHandlers} wired to injected command fakes. The
 * handler no longer constructs application commands or a GitHub adapter, so
 * tests exercise only event-mode gating, dispatch delegation, resume, and
 * in-flight lookup without full SessionManager/WorkspaceManager/Octokit
 * fixtures or prototype mutation.
 */
function makeHandlers(overrides: Partial<{
	dispatcher: { dispatch: (event: GitHubEvent) => Promise<void> };
	resumeSession: { execute: (owner: string, repo: string, issueNumber: number) => Promise<void> };
	restartRefinement: { restart: (owner: string, repo: string, issueNumber: number) => Promise<void> };
	isInFlight: (owner: string, repo: string, issueNumber: number) => boolean;
	resolveGitHubEventMode: (owner: string, repo: string) => RepoGitHubEventMode;
}> = {}) {
	const dispatcher = overrides.dispatcher ?? { dispatch: vi.fn(async () => undefined) };
	const resumeSession = overrides.resumeSession ?? { execute: vi.fn(async () => undefined) };
	const restartRefinement = overrides.restartRefinement ?? { restart: vi.fn(async () => undefined) };
	const isInFlight = overrides.isInFlight ?? vi.fn(() => false);
	const resolveGitHubEventMode = overrides.resolveGitHubEventMode;
	return new GitHubIssueHandlers({ dispatcher, resumeSession, restartRefinement, isInFlight, resolveGitHubEventMode });
}

function makeIssueEvent(source: GitHubEventSource, owner = "mbrooks", repo = "yolomatic"): GitHubEvent {
	return {
		id: `evt-${source}-${Math.random().toString(36).slice(2)}`,
		type: "issue",
		source,
		owner,
		repo,
		occurredAt: new Date().toISOString(),
		payload: {
			action: "opened",
			issue: { number: 56, title: "T", body: "B", assignees: [], labels: [], user: { login: "mbrooks" } },
			repository: { name: repo, owner: { login: owner } },
			sender: { login: "mbrooks" },
		},
	};
}

function makePushEvent(source: GitHubEventSource): GitHubEvent {
	return {
		id: `push-${source}-${Math.random().toString(36).slice(2)}`,
		type: "push",
		source,
		owner: "mbrooks",
		repo: "yolomatic",
		occurredAt: new Date().toISOString(),
		payload: {
			ref: "refs/heads/main",
			before: "old",
			after: "new",
			repository: { name: "yolomatic", owner: { login: "mbrooks" } },
			sender: { login: "human" },
		},
	};
}

describe("GitHubIssueHandlers.handleGitHubEvent dispatch", () => {
	it("dispatches the event to the injected dispatcher when no mode resolver is wired", async () => {
		const dispatch = vi.fn(async () => undefined);
		const handlers = makeHandlers({ dispatcher: { dispatch } });
		const event = makeIssueEvent("webhook");

		await handlers.handleGitHubEvent(event);

		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledWith(event);
	});

	it("dispatches a polling event when no mode resolver is wired", async () => {
		const dispatch = vi.fn(async () => undefined);
		const handlers = makeHandlers({ dispatcher: { dispatch } });

		await handlers.handleGitHubEvent(makeIssueEvent("polling"));
		expect(dispatch).toHaveBeenCalledTimes(1);
	});
});

describe("GitHubIssueHandlers.handleGitHubEvent mode gating", () => {
	function makeModeHandlers(mode: RepoGitHubEventMode) {
		const dispatch = vi.fn(async () => undefined);
		const resolveGitHubEventMode = vi.fn(() => mode);
		const handlers = makeHandlers({ dispatcher: { dispatch }, resolveGitHubEventMode });
		return { handlers, dispatch, resolveGitHubEventMode };
	}

	it("ignores a webhook event when the repo mode is polling-only", async () => {
		const { handlers, dispatch, resolveGitHubEventMode } = makeModeHandlers("polling");
		await handlers.handleGitHubEvent(makeIssueEvent("webhook"));

		expect(resolveGitHubEventMode).toHaveBeenCalledWith("mbrooks", "yolomatic");
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("ignores a polling event when the repo mode is webhook-only", async () => {
		const { handlers, dispatch } = makeModeHandlers("webhook");
		await handlers.handleGitHubEvent(makeIssueEvent("polling"));

		expect(dispatch).not.toHaveBeenCalled();
	});

	it("dispatches a webhook event when the repo mode includes webhook", async () => {
		const { handlers, dispatch } = makeModeHandlers("webhook");
		await handlers.handleGitHubEvent(makeIssueEvent("webhook"));

		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it("dispatches a polling event when the repo mode is both", async () => {
		const { handlers, dispatch } = makeModeHandlers("both");
		await handlers.handleGitHubEvent(makeIssueEvent("polling"));

		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it("dispatches a webhook event when the repo mode is both", async () => {
		const { handlers, dispatch } = makeModeHandlers("both");
		await handlers.handleGitHubEvent(makeIssueEvent("webhook"));

		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it("gates push events by source like other event types", async () => {
		const { handlers, dispatch } = makeModeHandlers("webhook");
		const pushEvent = makePushEvent("webhook");

		await handlers.handleGitHubEvent(pushEvent);
		expect(dispatch).toHaveBeenCalledTimes(1);

		await handlers.handleGitHubEvent({ ...pushEvent, id: "push-poll", source: "polling" });
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it("propagates dispatcher errors to the caller", async () => {
		const dispatch = vi.fn(async () => {
			throw new Error("boom");
		});
		const handlers = makeHandlers({ dispatcher: { dispatch } });

		await expect(handlers.handleGitHubEvent(makeIssueEvent("webhook"))).rejects.toThrow("boom");
	});
});

describe("GitHubIssueHandlers.resumeInterruptedSession", () => {
	it("invokes the injected resume command with the issue coordinates", async () => {
		const execute = vi.fn(async () => undefined);
		const handlers = makeHandlers({ resumeSession: { execute } });

		await handlers.resumeInterruptedSession("mbrooks", "yolomatic", 56);

		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledWith("mbrooks", "yolomatic", 56);
	});

	it("marks the issue in-flight for the duration of the resume call", async () => {
		const execute = vi.fn(async () => undefined);
		const commandsInFlight = vi.fn(() => false);
		const handlers = makeHandlers({ resumeSession: { execute }, isInFlight: commandsInFlight });

		let observedDuringResume = false;
		execute.mockImplementation(async () => {
			observedDuringResume = handlers.isInFlight("mbrooks", "yolomatic", 56);
		});

		await handlers.resumeInterruptedSession("mbrooks", "yolomatic", 56);

		expect(observedDuringResume).toBe(true);
		expect(handlers.isInFlight("mbrooks", "yolomatic", 56)).toBe(false);
	});

	it("clears the in-flight marker even when the resume command throws", async () => {
		const execute = vi.fn(async () => {
			throw new Error("resume failed");
		});
		const handlers = makeHandlers({ resumeSession: { execute } });

		await expect(handlers.resumeInterruptedSession("mbrooks", "yolomatic", 56)).rejects.toThrow("resume failed");
		expect(handlers.isInFlight("mbrooks", "yolomatic", 56)).toBe(false);
	});
});

describe("GitHubIssueHandlers.isInFlight", () => {
	it("delegates to the injected command in-flight lookup", () => {
		const isInFlight = vi.fn((_owner: string, _repo: string, issueNumber: number) => issueNumber === 56);
		const handlers = makeHandlers({ isInFlight });

		expect(handlers.isInFlight("mbrooks", "yolomatic", 56)).toBe(true);
		expect(handlers.isInFlight("mbrooks", "yolomatic", 57)).toBe(false);
		expect(isInFlight).toHaveBeenCalledWith("mbrooks", "yolomatic", 56);
	});
});

describe("GitHubIssueHandlers.restartRefinement", () => {
	it("delegates admin refinement restarts to the injected refinement command", async () => {
		const restart = vi.fn(async () => undefined);
		const handlers = makeHandlers({ restartRefinement: { restart } });

		await handlers.restartRefinement("mbrooks", "yolomatic", 658);

		expect(restart).toHaveBeenCalledTimes(1);
		expect(restart).toHaveBeenCalledWith("mbrooks", "yolomatic", 658);
	});
});