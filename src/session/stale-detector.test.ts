import { describe, expect, it, vi } from "vitest";
import { StaleSessionDetector } from "./stale-detector.js";
import type { SessionState } from "./store.js";

function makeSession(partial: Partial<SessionState> & { owner: string; repo: string; issueNumber: number }): SessionState {
	return {
		title: "Title",
		body: "Body",
		status: "working" as const,
		sessionPath: "/tmp/session.jsonl",
		workspacePath: "/tmp/ws",
		lastActivity: new Date().toISOString(),
		seeded: false,
		...partial,
	};
}

describe("StaleSessionDetector", () => {
	it("skips GitHub API calls for cron sessions", async () => {
		const sessionStore = {
			getAll: vi.fn(async () => [
				makeSession({ owner: "mbrooks", repo: "tars", issueNumber: -1, sessionType: "cron", status: "working" }),
			]),
		} as unknown as import("./store.js").SessionStore;

		const workspaceManager = {
			hasChanges: vi.fn(async () => false),
		} as unknown as import("../workspace/manager.js").WorkspaceManager;

		const detector = new StaleSessionDetector(
			sessionStore,
			workspaceManager,
			"fake-token",
			() => false,
			1000,
		);

		const result = await detector.detectStaleSessions();
		expect(result).toHaveLength(1);
		expect(result[0].isStale).toBe(false);
		expect(result[0].classification).toBe("unknown");
		expect(workspaceManager.hasChanges).not.toHaveBeenCalled();
	});
});
