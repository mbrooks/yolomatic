import { describe, expect, it, vi } from "vitest";
import { GetAdminStatus } from "./get-admin-status.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { StaleSessionService } from "../../ports/stale-session-service.js";
import type { Clock } from "../../ports/clock.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { SessionState } from "../../session/store.js";
import type { RepositoryStore } from "../../repos/repository-store.js";
import type { Repository } from "../../repos/repository.js";

function makeState(partial: Partial<SessionState> & { owner: string; repo: string; issueNumber: number }): SessionState {
	return {
		title: "Title",
		body: "Body",
		status: "pending" as const,
		sessionPath: "/tmp/session.jsonl",
		workspacePath: `/tmp/ws/issue-${partial.issueNumber}`,
		lastActivity: "2026-01-01T00:00:00Z",
		seeded: false,
		...partial,
	};
}

describe("GetAdminStatus", () => {
	it("returns online when no sessions are working or waiting feedback", async () => {
		const repo: SessionRepository = {
			getAll: vi.fn(async () => [
				makeState({ owner: "mbrooks", repo: "tars", issueNumber: 1, status: "pending" }),
				makeState({ owner: "mbrooks", repo: "tars", issueNumber: 2, status: "complete" }),
			]),
		} as unknown as SessionRepository;
		const stale: StaleSessionService = {
			detectStaleSessions: vi.fn(async () => []),
		};
		const clock: Clock = { now: () => new Date(), uptime: () => 3600 };
		const taskControl: TaskControlService = {
			cancel: vi.fn(),
			isActive: vi.fn(),
			steer: vi.fn(async () => false),
			register: vi.fn(),
			unregister: vi.fn(),
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
		};
		const query = new GetAdminStatus(repo, stale, clock, taskControl);
		const result = await query.execute();
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.agent).toBe("online");
			expect(result.data.sessions).toHaveLength(2);
			expect(result.data.uptime).toBe("1h");
			expect(result.data.draining).toBe(false);
		}
	});

	it("returns busy when a session is working", async () => {
		const repo: SessionRepository = {
			getAll: vi.fn(async () => [
				makeState({ owner: "mbrooks", repo: "tars", issueNumber: 1, status: "working" }),
			]),
		} as unknown as SessionRepository;
		const stale: StaleSessionService = {
			detectStaleSessions: vi.fn(async () => []),
		};
		const clock: Clock = { now: () => new Date(), uptime: () => 0 };
		const taskControl: TaskControlService = {
			cancel: vi.fn(),
			isActive: vi.fn(),
			steer: vi.fn(async () => false),
			register: vi.fn(),
			unregister: vi.fn(),
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
		};
		const query = new GetAdminStatus(repo, stale, clock, taskControl);
		const result = await query.execute();
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.agent).toBe("busy");
		}
	});

	it("returns repo summaries", async () => {
		const repo: SessionRepository = {
			getAll: vi.fn(async () => [
				makeState({ owner: "mbrooks", repo: "tars", issueNumber: 1, status: "working" }),
				makeState({ owner: "mbrooks", repo: "tars", issueNumber: 2, status: "complete" }),
				makeState({ owner: "mbrooks", repo: "case", issueNumber: 3, status: "pending" }),
			]),
		} as unknown as SessionRepository;
		const stale: StaleSessionService = {
			detectStaleSessions: vi.fn(async () => []),
		};
		const clock: Clock = { now: () => new Date(), uptime: () => 0 };
		const taskControl: TaskControlService = {
			cancel: vi.fn(),
			isActive: vi.fn(),
			steer: vi.fn(async () => false),
			register: vi.fn(),
			unregister: vi.fn(),
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
		};
		const query = new GetAdminStatus(repo, stale, clock, taskControl);
		const result = await query.execute();
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.repos).toHaveLength(2);
			expect(result.data.repos[0]).toEqual({ owner: "mbrooks", repo: "case", sessionCount: 1, activeCount: 1, lastActivity: "2026-01-01T00:00:00Z" });
			expect(result.data.repos[1]).toEqual({ owner: "mbrooks", repo: "tars", sessionCount: 2, activeCount: 1, lastActivity: "2026-01-01T00:00:00Z" });
		}
	});

	it("ignores stale detection errors", async () => {
		const repo: SessionRepository = {
			getAll: vi.fn(async () => []),
		} as unknown as SessionRepository;
		const stale: StaleSessionService = {
			detectStaleSessions: vi.fn(async () => {
				throw new Error("stale error");
			}),
		};
		const clock: Clock = { now: () => new Date(), uptime: () => 0 };
		const taskControl: TaskControlService = {
			cancel: vi.fn(),
			isActive: vi.fn(),
			steer: vi.fn(async () => false),
			register: vi.fn(),
			unregister: vi.fn(),
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
		};
		const query = new GetAdminStatus(repo, stale, clock, taskControl);
		const result = await query.execute();
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.sessions).toEqual([]);
		}
	});

	it("returns empty repos when no sessions and no managed repos", async () => {
		const repo: SessionRepository = {
			getAll: vi.fn(async () => []),
		} as unknown as SessionRepository;
		const stale: StaleSessionService = {
			detectStaleSessions: vi.fn(async () => []),
		};
		const clock: Clock = { now: () => new Date(), uptime: () => 0 };
		const taskControl: TaskControlService = {
			cancel: vi.fn(),
			isActive: vi.fn(),
			steer: vi.fn(async () => false),
			register: vi.fn(),
			unregister: vi.fn(),
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
		};
		const repositoryStore = {
			list: vi.fn(async () => []),
		} as unknown as RepositoryStore;
		const query = new GetAdminStatus(repo, stale, clock, taskControl, repositoryStore);
		const result = await query.execute();
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.repos).toEqual([]);
		}
	});

	it("adds managed repos with no sessions to the inventory", async () => {
		const repo: SessionRepository = {
			getAll: vi.fn(async () => []),
		} as unknown as SessionRepository;
		const stale: StaleSessionService = {
			detectStaleSessions: vi.fn(async () => []),
		};
		const clock: Clock = { now: () => new Date(), uptime: () => 0 };
		const taskControl: TaskControlService = {
			cancel: vi.fn(),
			isActive: vi.fn(),
			steer: vi.fn(async () => false),
			register: vi.fn(),
			unregister: vi.fn(),
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
		};
		const managed: Repository[] = [
			{ id: "mbrooks/valid", owner: "mbrooks", repo: "valid", fullName: null, visibility: null, githubEventMode: null, defaultBranch: null, createdAt: "", updatedAt: "" },
		];
		const repositoryStore = {
			list: vi.fn(async () => managed),
		} as unknown as RepositoryStore;
		const query = new GetAdminStatus(repo, stale, clock, taskControl, repositoryStore);
		const result = await query.execute();
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.repos).toEqual([
				{ owner: "mbrooks", repo: "valid", sessionCount: 0, activeCount: 0, lastActivity: null },
			]);
		}
	});

	it("returns draining flag from task controller", async () => {
		const repo: SessionRepository = {
			getAll: vi.fn(async () => []),
		} as unknown as SessionRepository;
		const stale: StaleSessionService = {
			detectStaleSessions: vi.fn(async () => []),
		};
		const clock: Clock = { now: () => new Date(), uptime: () => 0 };
		const taskControl: TaskControlService = {
			cancel: vi.fn(),
			isActive: vi.fn(),
			steer: vi.fn(async () => false),
			register: vi.fn(),
			unregister: vi.fn(),
			isDraining: vi.fn(() => true),
			setDraining: vi.fn(),
		};
		const query = new GetAdminStatus(repo, stale, clock, taskControl);
		const result = await query.execute();
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.draining).toBe(true);
		}
	});

	it("merges configured onboarding repos into inventory", async () => {
		const repo: SessionRepository = {
			getAll: vi.fn(async () => [
				makeState({ owner: "mbrooks", repo: "tars", issueNumber: 1, status: "working" }),
			]),
		} as unknown as SessionRepository;
		const stale: StaleSessionService = {
			detectStaleSessions: vi.fn(async () => []),
		};
		const clock: Clock = { now: () => new Date(), uptime: () => 0 };
		const taskControl: TaskControlService = {
			cancel: vi.fn(),
			isActive: vi.fn(),
			steer: vi.fn(async () => false),
			register: vi.fn(),
			unregister: vi.fn(),
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
		};
		const managed: Repository[] = [
			{ id: "mbrooks/tars", owner: "mbrooks", repo: "tars", fullName: null, visibility: null, githubEventMode: null, defaultBranch: null, createdAt: "", updatedAt: "" },
			{ id: "mbrooks/new-repo", owner: "mbrooks", repo: "new-repo", fullName: null, visibility: null, githubEventMode: null, defaultBranch: null, createdAt: "", updatedAt: "" },
		];
		const repositoryStore = {
			list: vi.fn(async () => managed),
		} as unknown as RepositoryStore;
		const query = new GetAdminStatus(repo, stale, clock, taskControl, repositoryStore);
		const result = await query.execute();
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.repos).toEqual([
				{ owner: "mbrooks", repo: "new-repo", sessionCount: 0, activeCount: 0, lastActivity: null },
				{ owner: "mbrooks", repo: "tars", sessionCount: 1, activeCount: 1, lastActivity: "2026-01-01T00:00:00Z" },
			]);
		}
	});

	it("exposes execution time fields in the session view", async () => {
		const repo: SessionRepository = {
			getAll: vi.fn(async () => [
				makeState({
					owner: "mbrooks",
					repo: "tars",
					issueNumber: 1,
					status: "working",
					taskStartedAt: "2026-01-01T00:00:00Z",
					taskFinishedAt: "2026-01-01T00:01:00Z",
					totalExecutionTimeMs: 60_000,
				}),
			]),
		} as unknown as SessionRepository;
		const stale: StaleSessionService = {
			detectStaleSessions: vi.fn(async () => []),
		};
		const clock: Clock = { now: () => new Date(), uptime: () => 0 };
		const taskControl: TaskControlService = {
			cancel: vi.fn(),
			isActive: vi.fn(),
			steer: vi.fn(async () => false),
			register: vi.fn(),
			unregister: vi.fn(),
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
		};
		const query = new GetAdminStatus(repo, stale, clock, taskControl);
		const result = await query.execute();
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.sessions[0]).toMatchObject({
				taskStartedAt: "2026-01-01T00:00:00Z",
				taskFinishedAt: "2026-01-01T00:01:00Z",
				totalExecutionTimeMs: 60_000,
			});
		}
	});

	it("exposes issue title, body, and summary in the session view", async () => {
		const repo: SessionRepository = {
			getAll: vi.fn(async () => [
				makeState({
					owner: "mbrooks",
					repo: "tars",
					issueNumber: 1,
					status: "working",
					title: "Fix the thing",
					body: "The thing is broken and needs fixing.",
					summary: "Short summary of the issue.",
				}),
			]),
		} as unknown as SessionRepository;
		const stale: StaleSessionService = {
			detectStaleSessions: vi.fn(async () => []),
		};
		const clock: Clock = { now: () => new Date(), uptime: () => 0 };
		const taskControl: TaskControlService = {
			cancel: vi.fn(),
			isActive: vi.fn(),
			steer: vi.fn(async () => false),
			register: vi.fn(),
			unregister: vi.fn(),
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
		};
		const query = new GetAdminStatus(repo, stale, clock, taskControl);
		const result = await query.execute();
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.sessions[0]).toMatchObject({
				title: "Fix the thing",
				body: "The thing is broken and needs fixing.",
				summary: "Short summary of the issue.",
			});
		}
	});

	it("coerces a missing optional summary to null while preserving title and body", async () => {
		const repo: SessionRepository = {
			getAll: vi.fn(async () => [
				makeState({
					owner: "mbrooks",
					repo: "tars",
					issueNumber: 1,
					status: "working",
					title: "Fix the thing",
					body: "The thing is broken.",
					summary: undefined,
				}),
			]),
		} as unknown as SessionRepository;
		const stale: StaleSessionService = {
			detectStaleSessions: vi.fn(async () => []),
		};
		const clock: Clock = { now: () => new Date(), uptime: () => 0 };
		const taskControl: TaskControlService = {
			cancel: vi.fn(),
			isActive: vi.fn(),
			steer: vi.fn(async () => false),
			register: vi.fn(),
			unregister: vi.fn(),
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
		};
		const query = new GetAdminStatus(repo, stale, clock, taskControl);
		const result = await query.execute();
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.sessions[0]).toMatchObject({
				title: "Fix the thing",
				body: "The thing is broken.",
				summary: null,
			});
		}
	});

	it("coerces undefined title and body to null when risk detection is stubbed", async () => {
		const model = await import("../../domain/session/model.js");
		const riskSpy = vi.spyOn(model, "detectSessionRisk").mockReturnValue({
			suspectedMisroute: false,
			reasons: [],
			referencedIssueNumber: null,
		});
		const repo: SessionRepository = {
			getAll: vi.fn(async () => [
				makeState({
					owner: "mbrooks",
					repo: "tars",
					issueNumber: 1,
					status: "working",
					title: undefined as unknown as string,
					body: undefined as unknown as string,
					summary: undefined,
				}),
			]),
		} as unknown as SessionRepository;
		const stale: StaleSessionService = {
			detectStaleSessions: vi.fn(async () => []),
		};
		const clock: Clock = { now: () => new Date(), uptime: () => 0 };
		const taskControl: TaskControlService = {
			cancel: vi.fn(),
			isActive: vi.fn(),
			steer: vi.fn(async () => false),
			register: vi.fn(),
			unregister: vi.fn(),
			isDraining: vi.fn(() => false),
			setDraining: vi.fn(),
		};
		const query = new GetAdminStatus(repo, stale, clock, taskControl);
		const result = await query.execute();
		riskSpy.mockRestore();
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.sessions[0]).toMatchObject({
				title: null,
				body: null,
				summary: null,
			});
		}
	});
});
