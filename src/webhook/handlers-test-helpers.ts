import { vi, type Mock } from "vitest";

import type { ExecutionService } from "../ports/execution-service.js";
import type { SessionRepository } from "../ports/session-repository.js";
import type { WorkspaceService } from "../ports/workspace-service.js";
import type { ExecutionResult } from "../executor/index.js";
import type { SessionKind, SessionState, SessionStatus } from "../session/store.js";

/**
 * Test-only extension of {@link SessionRepository} that also exposes the
 * `getSession` alias the real `SessionManager` class provides. Production
 * commands call `sessions.get`, but tests assert on `getSession` because the
 * real `SessionManager.get` delegates to it. Typing the fake against this
 * interface keeps those assertions type-checked.
 *
 * Every member is a vitest {@link Mock} so tests can call
 * `mockResolvedValue` / inspect `.mock.calls` on any method.
 */
export type FakeSessionManager = {
	get: Mock<SessionRepository["get"]>;
	getSession: Mock<
		(
			owner: string,
			repo: string,
			issueNumber: number,
			kind?: SessionKind,
		) => Promise<SessionState | null>
	>;
	getAll: Mock<() => Promise<SessionState[]>>;
	save: Mock<(state: SessionState) => Promise<SessionState>>;
	delete: Mock<SessionRepository["delete"]>;
	archive: Mock<SessionRepository["archive"]>;
	createSession: Mock<SessionRepository["createSession"]>;
	updateStatus: Mock<SessionRepository["updateStatus"]>;
	markSeeded: Mock<SessionRepository["markSeeded"]>;
	associatePR: Mock<SessionRepository["associatePR"]>;
	incrementIterationCount: Mock<SessionRepository["incrementIterationCount"]>;
	findSessionByPR: Mock<SessionRepository["findSessionByPR"]>;
	cancelSession: Mock<SessionRepository["cancelSession"]>;
	pauseSession: Mock<SessionRepository["pauseSession"]>;
	unpauseSession: Mock<SessionRepository["unpauseSession"]>;
	restartSession: Mock<SessionRepository["restartSession"]>;
	markComplete: Mock<SessionRepository["markComplete"]>;
	markFailed: Mock<SessionRepository["markFailed"]>;
	markStale: Mock<SessionRepository["markStale"]>;
};

const DEFAULT_EXECUTION_RESULT: ExecutionResult = {
	status: "complete",
	summary: "Done.",
	rawResponse: "YOLO_STATUS: complete\nDone.",
};

/**
 * Build a fully-typed {@link FakeSessionManager} test double. Every method of
 * the interface is stubbed with a no-op `vi.fn`; pass overrides only for the
 * methods the scenario exercises. The default `get` delegates to `getSession`
 * so tests can drive behavior and assertions through `getSession` alone.
 *
 * Because the returned object is checked against {@link FakeSessionManager},
 * removing a required method from the defaults fails TypeScript checking.
 */
export function makeSessionManager(
	overrides: Partial<FakeSessionManager> = {},
): FakeSessionManager {
	const getSession = overrides.getSession ?? vi.fn(async () => null);
	const base: FakeSessionManager = {
		get: vi.fn(async (owner, repo, issueNumber, kind) =>
			getSession(owner, repo, issueNumber, kind),
		),
		getSession,
		getAll: vi.fn(async () => []),
		save: vi.fn(async (state: SessionState) => state),
		delete: vi.fn(async () => undefined),
		archive: vi.fn(async () => undefined),
		createSession: vi.fn(
			async (_owner, _repo, issueNumber, title, body, workspacePath) => ({
				kind: "implementation" as SessionKind,
				issueNumber,
				repo: "yolomatic",
				owner: "mbrooks",
				title,
				body,
				status: "pending" as SessionStatus,
				sessionPath: `/tmp/sessions/github-mbrooks-yolomatic/issue-${issueNumber}.jsonl`,
				workspacePath,
				lastActivity: new Date().toISOString(),
				seeded: false,
			}),
		),
		updateStatus: vi.fn(async (_owner, _repo, issueNumber, status) => ({
			kind: "implementation" as SessionKind,
			issueNumber,
			repo: "yolomatic",
			owner: "mbrooks",
			title: "Title",
			body: "Body",
			status,
			sessionPath: `/tmp/sessions/github-mbrooks-yolomatic/issue-${issueNumber}.jsonl`,
			workspacePath: `/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-${issueNumber}`,
			lastActivity: new Date().toISOString(),
			seeded: false,
		})),
		markSeeded: vi.fn(async () => undefined as unknown as SessionState),
		associatePR: vi.fn(async () => undefined as unknown as SessionState),
		incrementIterationCount: vi.fn(async () => undefined as unknown as SessionState),
		findSessionByPR: vi.fn(async () => null),
		cancelSession: vi.fn(async () => undefined as unknown as SessionState),
		pauseSession: vi.fn(async () => undefined as unknown as SessionState),
		unpauseSession: vi.fn(async () => undefined as unknown as SessionState),
		restartSession: vi.fn(async () => undefined as unknown as SessionState),
		markComplete: vi.fn(async () => undefined as unknown as SessionState),
		markFailed: vi.fn(async () => undefined as unknown as SessionState),
		markStale: vi.fn(async () => undefined as unknown as SessionState),
	};
	return { ...base, ...overrides };
}

/** Typed {@link WorkspaceService} test double. No `.mock*` calls are made on
 * workspace methods in the suites, so the plain interface type is enough to
 * catch omitted methods while keeping `expect(...).toHaveBeenCalledWith` work. */
export type FakeWorkspaceManager = WorkspaceService;

/**
 * Build a fully-typed {@link WorkspaceService} test double. Every interface
 * method is stubbed; pass overrides for the ones the scenario reaches. The
 * `syncWorktree` default is included so handler paths that sync the worktree
 * no longer silently skip it when a test forgets to stub it.
 */
export function makeWorkspaceManager(
	overrides: Partial<FakeWorkspaceManager> = {},
): FakeWorkspaceManager {
	const base: FakeWorkspaceManager = {
		updateDefaultBranchFromOrigin: vi.fn(async () => ({
			branch: "main",
			before: null,
			after: "main",
			updated: false,
		})),
		createOrGetWorktree: vi.fn(async () => ({
			path: "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
			branch: "yolomatic/issue-1",
		})),
		syncWorktree: vi.fn(async () => undefined),
		removeWorktree: vi.fn(async () => undefined),
		commitAndPush: vi.fn(async () => true),
		commitAndPushPath: vi.fn(async () => true),
		hasChanges: vi.fn(async () => false),
		getWorktreePath: vi.fn(
			() => "/tmp/workspaces/mbrooks-yolomatic/.worktrees/issue-1",
		),
		getGitStatus: vi.fn(async () => ""),
		getGitDiff: vi.fn(async () => ""),
	};
	return { ...base, ...overrides };
}

/** Typed {@link ExecutionService} test double where every method is a Mock. */
export type FakeExecutor = {
	[K in keyof ExecutionService]: Mock<ExecutionService[K]>;
};

/**
 * Build a fully-typed {@link ExecutionService} test double. `execute` and
 * `executePRReview` default to a `complete` result; pass overrides for the
 * scenarios that need a different status or a thrown error.
 */
export function makeExecutor(
	overrides: Partial<FakeExecutor> = {},
): FakeExecutor {
	const base: FakeExecutor = {
		execute: vi.fn(async () => DEFAULT_EXECUTION_RESULT),
		executePRReview: vi.fn(async () => DEFAULT_EXECUTION_RESULT),
	};
	return { ...base, ...overrides };
}