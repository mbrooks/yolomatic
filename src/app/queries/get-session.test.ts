import { describe, expect, it, vi } from "vitest";
import { GetSession } from "./get-session.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { SessionState } from "../../session/store.js";

describe("GetSession", () => {
	it("returns the session when found", async () => {
		const state: SessionState = {
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 1,
			title: "Test",
			body: "Body",
			status: "working",
			sessionPath: "/tmp/session.jsonl",
			workspacePath: "/tmp/ws",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};
		const repo: SessionRepository = {
			get: vi.fn(async () => state),
		} as unknown as SessionRepository;
		const query = new GetSession(repo);
		const result = await query.execute("mbrooks", "yolomatic", 1);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual(state);
		}
	});

	it("returns not_found when session does not exist", async () => {
		const repo: SessionRepository = {
			get: vi.fn(async () => null),
		} as unknown as SessionRepository;
		const query = new GetSession(repo);
		const result = await query.execute("mbrooks", "yolomatic", 999);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("not_found");
		}
	});
});
