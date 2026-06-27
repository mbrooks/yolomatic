import { describe, expect, it, vi } from "vitest";
import { GetAdminStatus } from "./get-admin-status.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { StaleSessionService } from "../../ports/stale-session-service.js";
import type { Clock } from "../../ports/clock.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { SessionState } from "../../session/store.js";
import type { SettingsStore } from "../../settings/store.js";

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

	it("ignores invalid configured_repositories", async () => {
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
		const settingsStore = {
			get: vi.fn((key: string) => {
				if (key === "configured_repositories") return "not json";
				return undefined;
			}),
		} as unknown as SettingsStore;
		const query = new GetAdminStatus(repo, stale, clock, taskControl, settingsStore);
		const result = await query.execute();
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.repos).toEqual([]);
		}
	});

	it("filters malformed configured repositories", async () => {
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
		const settingsStore = {
			get: vi.fn((key: string) => {
				if (key === "configured_repositories") {
					return JSON.stringify([
						null,
						"not an object",
						{ owner: "  ", repo: "tars" },
						{ owner: "mbrooks", repo: "" },
						{ owner: "mbrooks", repo: "valid" },
						{ owner: "mbrooks", repo: "valid" },
					]);
				}
				return undefined;
			}),
		} as unknown as SettingsStore;
		const query = new GetAdminStatus(repo, stale, clock, taskControl, settingsStore);
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
		const settingsStore = {
			get: vi.fn((key: string) => {
				if (key === "configured_repositories") {
					return JSON.stringify([
						{ owner: "mbrooks", repo: "tars" },
						{ owner: "mbrooks", repo: "new-repo" },
					]);
				}
				return undefined;
			}),
		} as unknown as SettingsStore;
		const query = new GetAdminStatus(repo, stale, clock, taskControl, settingsStore);
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
});
