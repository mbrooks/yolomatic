import { describe, expect, it, vi } from "vitest";
import { GetSessionLog } from "./get-session-log.js";
import { _resetSessionLogs, recordSessionLog } from "../../logging/session-log-store.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import { sessionStorageKey, type SessionState } from "../../session/store.js";

describe("GetSessionLog", () => {
	it("returns logs when session exists and logs are recorded", async () => {
		_resetSessionLogs();
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
		const key = sessionStorageKey("mbrooks", "yolomatic", 1, "implementation");
		recordSessionLog(key, { level: "info", message: "Prompt sent" });
		recordSessionLog(key, { level: "tool", message: "read file" });

		const query = new GetSessionLog(repo);
		const result = await query.execute("mbrooks", "yolomatic", 1);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.available).toBe(true);
			expect(result.data.logs.length).toBe(2);
			expect(result.data.logs[0].level).toBe("info");
			expect(result.data.logs[1].level).toBe("tool");
		}
	});

	it("returns empty logs when no logs recorded", async () => {
		_resetSessionLogs();
		const state: SessionState = {
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 2,
			title: "Test",
			body: "Body",
			status: "working",
			sessionPath: "/tmp/session2.jsonl",
			workspacePath: "/tmp/ws",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};
		const repo: SessionRepository = {
			get: vi.fn(async () => state),
		} as unknown as SessionRepository;

		const query = new GetSessionLog(repo);
		const result = await query.execute("mbrooks", "yolomatic", 2);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.available).toBe(true);
			expect(result.data.logs).toEqual([]);
		}
	});

	it("filters logs by since timestamp", async () => {
		_resetSessionLogs();
		const state: SessionState = {
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 3,
			title: "Test",
			body: "Body",
			status: "working",
			sessionPath: "/tmp/session3.jsonl",
			workspacePath: "/tmp/ws",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};
		const repo: SessionRepository = {
			get: vi.fn(async () => state),
		} as unknown as SessionRepository;
		const key = sessionStorageKey("mbrooks", "yolomatic", 3, "implementation");
		recordSessionLog(key, { level: "info", message: "old" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		recordSessionLog(key, { level: "info", message: "new" });

		const query = new GetSessionLog(repo);
		const full = await query.execute("mbrooks", "yolomatic", 3);
		expect(full.success).toBe(true);
		if (!full.success) return;
		const since = full.data.logs[0].timestamp;
		const filtered = await query.execute("mbrooks", "yolomatic", 3, since);
		expect(filtered.success).toBe(true);
		if (filtered.success) {
			expect(filtered.data.logs.length).toBe(1);
			expect(filtered.data.logs[0].message).toBe("new");
		}
	});

	it("returns not_found when session does not exist", async () => {
		_resetSessionLogs();
		const repo: SessionRepository = {
			get: vi.fn(async () => null),
		} as unknown as SessionRepository;
		const query = new GetSessionLog(repo);
		const result = await query.execute("mbrooks", "yolomatic", 999);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("not_found");
		}
	});
});
