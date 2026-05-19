import { describe, expect, it, vi } from "vitest";
import { GetAdminStatus } from "./get-admin-status.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { StaleSessionService } from "../../ports/stale-session-service.js";
import type { Clock } from "../../ports/clock.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { SessionState } from "../../session/store.js";

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
			expect(result.data.repos[0]).toEqual({ owner: "mbrooks", repo: "case", sessionCount: 1, activeCount: 1 });
			expect(result.data.repos[1]).toEqual({ owner: "mbrooks", repo: "tars", sessionCount: 2, activeCount: 1 });
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
});
