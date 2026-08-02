import { describe, expect, it, vi } from "vitest";

import { ResumeInterruptedSession } from "./resume-interrupted-session.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { ExecuteSessionDeps } from "./execute-session.js";
import type { SessionState } from "../../session/store.js";

vi.mock("./workflow-helpers.js", () => ({
	issueSessionKey: (owner: string, repo: string, issueNumber: number) =>
		`github-${owner}-${repo}-issue-${issueNumber}`,
	markIssueWorking: vi.fn(async () => undefined),
}));

vi.mock("./execute-session.js", () => ({
	ExecuteSession: class {
		run = vi.fn(async () => undefined);
	},
}));

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
	return {
		owner: "mbrooks",
		repo: "yeetomatic",
		issueNumber: 7,
		status: "working",
		sessionPath: "/tmp/sessions/github-mbrooks-yeetomatic/issue-7.jsonl",
		workspacePath: "/tmp/ws",
		lastActivity: new Date(0).toISOString(),
		seeded: false,
		...overrides,
	} as SessionState;
}

function makeDeps(session: SessionState | null) {
	const sessions: SessionRepository = {
		get: vi.fn(async () => session),
		save: vi.fn(async (s) => s),
		updateStatus: vi.fn(async (_owner, _repo, _issueNumber, status, updates) => ({
			...session!,
			...updates,
			status,
		})),
	} as unknown as SessionRepository;
	const github: GitHubService = {
		postComment: vi.fn(async () => 1),
	} as unknown as GitHubService;
	const executor = {} as ExecuteSessionDeps;
	return { sessions, github, executor };
}

describe("ResumeInterruptedSession", () => {
	it("does nothing when no session exists", async () => {
		const deps = makeDeps(null);
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const command = new ResumeInterruptedSession(deps);
		await command.execute("mbrooks", "yeetomatic", 7);

		expect(deps.github.postComment).not.toHaveBeenCalled();
		expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("no session for"));

		writeSpy.mockRestore();
	});

	it("skips sessions in a terminal status", async () => {
		const deps = makeDeps(makeSession({ status: "complete" }));
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const command = new ResumeInterruptedSession(deps);
		await command.execute("mbrooks", "yeetomatic", 7);

		expect(deps.github.postComment).not.toHaveBeenCalled();
		expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("terminal status"));

		writeSpy.mockRestore();
	});

	it("marks interrupted refinement sessions failed instead of resuming implementation", async () => {
		const deps = makeDeps(makeSession({ kind: "refinement", status: "working", resumeOnBoot: true }));

		const command = new ResumeInterruptedSession(deps);
		await command.execute("mbrooks", "yeetomatic", 7);

		expect(deps.sessions.updateStatus).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			7,
			"failed",
			expect.objectContaining({
				summary: "interrupted by restart",
				staleReason: "interrupted by restart",
				resumeOnBoot: undefined,
			}),
		);
		expect(deps.github.postComment).not.toHaveBeenCalled();
	});

	it("posts a resume comment and re-runs a working session", async () => {
		const deps = makeDeps(makeSession({ status: "working" }));

		const command = new ResumeInterruptedSession(deps);
		await command.execute("mbrooks", "yeetomatic", 7);

		expect(deps.github.postComment).toHaveBeenCalledWith(
			"mbrooks",
			"yeetomatic",
			7,
			"Yeetomatic was restarted while working on this issue. Resuming work...",
		);
	});

	it("marks a queued (pending) session working and re-runs it", async () => {
		const deps = makeDeps(makeSession({ status: "pending" }));
		const { markIssueWorking } = await import("./workflow-helpers.js");

		const command = new ResumeInterruptedSession(deps);
		await command.execute("mbrooks", "yeetomatic", 7);

		expect(markIssueWorking).toHaveBeenCalledWith(
			deps.github,
			"mbrooks",
			"yeetomatic",
			7,
			"Yeetomatic was restarted while queued. Picking up work...",
		);
	});

	it("marks a waiting-feedback session working with the queued-feedback message and re-runs it", async () => {
		const deps = makeDeps(makeSession({ status: "waiting-feedback" }));
		const { markIssueWorking } = await import("./workflow-helpers.js");

		const command = new ResumeInterruptedSession(deps);
		await command.execute("mbrooks", "yeetomatic", 7);

		expect(markIssueWorking).toHaveBeenCalledWith(
			deps.github,
			"mbrooks",
			"yeetomatic",
			7,
			"Yeetomatic was restarted with queued feedback. Resuming work...",
		);
	});

	it("falls back to the generic resume message for any other non-terminal status", async () => {
		const deps = makeDeps(makeSession({ status: "paused" }));
		const { markIssueWorking } = await import("./workflow-helpers.js");

		const command = new ResumeInterruptedSession(deps);
		await command.execute("mbrooks", "yeetomatic", 7);

		expect(markIssueWorking).toHaveBeenCalledWith(
			deps.github,
			"mbrooks",
			"yeetomatic",
			7,
			"Yeetomatic was restarted. Resuming work...",
		);
	});

	it("clears resumeOnBoot and queuedComments after resuming and saves the session", async () => {
		const session = makeSession({ status: "paused", resumeOnBoot: true, queuedComments: ["a", "b"] });
		const deps = makeDeps(session);

		const command = new ResumeInterruptedSession(deps);
		await command.execute("mbrooks", "yeetomatic", 7);

		expect(deps.sessions.save).toHaveBeenCalledTimes(1);
		const saved = vi.mocked(deps.sessions.save).mock.calls[0][0] as SessionState;
		expect(saved.resumeOnBoot).toBeUndefined();
		expect(saved.queuedComments).toBeUndefined();
	});

	it("does not save when the latest session has no resumeOnBoot or queuedComments", async () => {
		const session = makeSession({ status: "paused" });
		const deps = makeDeps(session);

		const command = new ResumeInterruptedSession(deps);
		await command.execute("mbrooks", "yeetomatic", 7);

		expect(deps.sessions.save).not.toHaveBeenCalled();
	});
});
