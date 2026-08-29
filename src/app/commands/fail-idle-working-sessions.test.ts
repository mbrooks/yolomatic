import { describe, expect, it, vi } from "vitest";

import {
	FailIdleWorkingSessions,
	idleWorkingFailReason,
	type IdleWorkingSweepSessionPort,
	type IdleWorkingSweepTaskPort,
} from "./fail-idle-working-sessions.js";
import type { SessionState } from "../../session/store.js";

const HOUR_MS = 60 * 60 * 1000;

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
	return {
		owner: "mbrooks",
		repo: "yolomatic",
		issueNumber: 901,
		title: "test",
		body: "",
		status: "working",
		sessionPath: "/tmp/session.jsonl",
		workspacePath: "/tmp/worktree",
		lastActivity: new Date().toISOString(),
		seeded: false,
		...overrides,
	} as SessionState;
}

function hoursAgo(hours: number): string {
	return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

function makePorts(sessions: SessionState[]) {
	const tasks: IdleWorkingSweepTaskPort = {
		isInFlight: vi.fn(() => false),
	};
	const sessionsPort: IdleWorkingSweepSessionPort = {
		getAll: vi.fn(async () => sessions),
		markFailed: vi.fn(async () => makeSession()),
	};
	return { sessions: sessionsPort, tasks };
}

describe("FailIdleWorkingSessions", () => {
	it("fails a working session idle beyond the threshold that is not in-flight", async () => {
		const stale = makeSession({ issueNumber: 901, lastActivity: hoursAgo(2) });
		const { sessions, tasks } = makePorts([stale]);
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const command = new FailIdleWorkingSessions(sessions, tasks);
		const result = await command.execute(HOUR_MS);

		expect(result).toEqual({ failed: 1, errors: 0 });
		expect(sessions.markFailed).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			901,
			expect.stringContaining("no activity"),
			"implementation",
		);

		writeSpy.mockRestore();
	});

	it("keeps a working session with recent activity", async () => {
		const fresh = makeSession({ issueNumber: 902, lastActivity: hoursAgo(0.5) });
		const { sessions, tasks } = makePorts([fresh]);

		const command = new FailIdleWorkingSessions(sessions, tasks);
		const result = await command.execute(HOUR_MS);

		expect(result).toEqual({ failed: 0, errors: 0 });
		expect(sessions.markFailed).not.toHaveBeenCalled();
	});

	it("does not fail a working session idle for exactly the threshold (must exceed)", async () => {
		const atThreshold = makeSession({ issueNumber: 903, lastActivity: new Date(0).toISOString() });
		const { sessions, tasks } = makePorts([atThreshold]);

		const command = new FailIdleWorkingSessions(sessions, tasks);
		// Fixed clock 1h after the session's last activity: idle time equals the
		// threshold exactly, which must NOT fail (only exceeding does).
		const fixedNow = new Date(0).getTime() + HOUR_MS;
		const result = await command.execute(HOUR_MS, () => fixedNow);

		expect(result).toEqual({ failed: 0, errors: 0 });
		expect(sessions.markFailed).not.toHaveBeenCalled();
	});

	it("never fails an in-flight working session even when idle beyond the threshold", async () => {
		const inFlight = makeSession({ issueNumber: 904, lastActivity: hoursAgo(2) });
		const { sessions, tasks } = makePorts([inFlight]);
		tasks.isInFlight = vi.fn((owner: string, repo: string, issueNumber: number) =>
			owner === "mbrooks" && repo === "yolomatic" && issueNumber === 904,
		);

		const command = new FailIdleWorkingSessions(sessions, tasks);
		const result = await command.execute(HOUR_MS);

		expect(result).toEqual({ failed: 0, errors: 0 });
		expect(sessions.markFailed).not.toHaveBeenCalled();
	});

	it("ignores pending, waiting-feedback, paused, and terminal-status sessions", async () => {
		const sessions = [
			makeSession({ issueNumber: 910, status: "pending", lastActivity: hoursAgo(5) }),
			makeSession({ issueNumber: 911, status: "waiting-feedback", lastActivity: hoursAgo(5) }),
			makeSession({ issueNumber: 912, status: "paused", lastActivity: hoursAgo(5) }),
			makeSession({ issueNumber: 913, status: "complete", lastActivity: hoursAgo(5) }),
			makeSession({ issueNumber: 914, status: "failed", lastActivity: hoursAgo(5) }),
			makeSession({ issueNumber: 915, status: "cancelled", lastActivity: hoursAgo(5) }),
		];
		const { sessions: sessionsPort, tasks } = makePorts(sessions);

		const command = new FailIdleWorkingSessions(sessionsPort, tasks);
		const result = await command.execute(HOUR_MS);

		expect(result).toEqual({ failed: 0, errors: 0 });
		expect(sessionsPort.markFailed).not.toHaveBeenCalled();
	});

	it("fails an idle working refinement session with the refinement kind", async () => {
		const staleRefinement = makeSession({
			kind: "refinement",
			issueNumber: 905,
			lastActivity: hoursAgo(2),
		});
		const { sessions, tasks } = makePorts([staleRefinement]);

		const command = new FailIdleWorkingSessions(sessions, tasks);
		const result = await command.execute(HOUR_MS);

		expect(result).toEqual({ failed: 1, errors: 0 });
		expect(sessions.markFailed).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			905,
			expect.stringContaining("no activity"),
			"refinement",
		);
	});

	it("swallows a per-session markFailed error and continues with the remaining sessions", async () => {
		const broken = makeSession({ issueNumber: 906, lastActivity: hoursAgo(2) });
		const healthy = makeSession({ issueNumber: 907, lastActivity: hoursAgo(2) });
		const failures: unknown[] = [new Error("store write failed"), "non-error failure"];
		const tasks: IdleWorkingSweepTaskPort = { isInFlight: vi.fn(() => false) };
		const sessionsPort: IdleWorkingSweepSessionPort = {
			getAll: vi.fn(async () => [broken, healthy]),
			markFailed: vi.fn(async () => {
				// Non-Error rejection on the second call exercises the String(error) branch.
				throw failures.shift();
			}),
		};
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const command = new FailIdleWorkingSessions(sessionsPort, tasks);
		const result = await command.execute(HOUR_MS);

		expect(result).toEqual({ failed: 0, errors: 2 });
		expect(sessionsPort.markFailed).toHaveBeenCalledTimes(2);
		expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("failed to mark mbrooks/yolomatic#906"));

		writeSpy.mockRestore();
	});

	it("defaults a legacy session without a kind to the implementation kind", async () => {
		const legacy = makeSession({ issueNumber: 906, lastActivity: hoursAgo(2) }) as SessionState;
		delete (legacy as { kind?: string }).kind;
		const { sessions, tasks } = makePorts([legacy]);

		const command = new FailIdleWorkingSessions(sessions, tasks);
		const result = await command.execute(HOUR_MS);

		expect(result).toEqual({ failed: 1, errors: 0 });
		expect(sessions.markFailed).toHaveBeenCalledWith(
			"mbrooks",
			"yolomatic",
			906,
			expect.stringContaining("no activity"),
			"implementation",
		);
	});

	it("exposes a readable failure reason for a one-hour threshold", () => {
		expect(idleWorkingFailReason(HOUR_MS)).toBe("no activity for over 60 minutes");
	});

	it("clamps sub-minute thresholds to one minute in the failure reason", () => {
		expect(idleWorkingFailReason(500)).toBe("no activity for over 1 minutes");
	});
});