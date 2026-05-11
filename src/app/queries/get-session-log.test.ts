import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GetSessionLog } from "./get-session-log.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { SessionState } from "../../session/store.js";

describe("GetSessionLog", () => {
	it("returns log lines when log file exists", async () => {
		const sessionsDir = await mkdtemp(join(tmpdir(), "tars-logs-"));
		const sessionPath = join(sessionsDir, "issue-1.jsonl");
		await writeFile(sessionPath, '{"type":"prompt"}\n{"type":"response"}\n');
		const state: SessionState = {
			owner: "mbrooks",
			repo: "tars",
			issueNumber: 1,
			title: "Test",
			body: "Body",
			status: "working",
			sessionPath,
			workspacePath: "/tmp/ws",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};
		const repo: SessionRepository = {
			get: vi.fn(async () => state),
		} as unknown as SessionRepository;
		const query = new GetSessionLog(repo);
		const result = await query.execute("mbrooks", "tars", 1);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.available).toBe(true);
			expect(result.data.lines).toEqual(['{"type":"prompt"}', '{"type":"response"}']);
		}
	});

	it("returns unavailable when log file is missing", async () => {
		const state: SessionState = {
			owner: "mbrooks",
			repo: "tars",
			issueNumber: 1,
			title: "Test",
			body: "Body",
			status: "working",
			sessionPath: "/nonexistent/path.jsonl",
			workspacePath: "/tmp/ws",
			lastActivity: new Date().toISOString(),
			seeded: false,
		};
		const repo: SessionRepository = {
			get: vi.fn(async () => state),
		} as unknown as SessionRepository;
		const query = new GetSessionLog(repo);
		const result = await query.execute("mbrooks", "tars", 1);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.available).toBe(false);
			expect(result.data.error).toBe("Log file not found");
		}
	});

	it("returns not_found when session does not exist", async () => {
		const repo: SessionRepository = {
			get: vi.fn(async () => null),
		} as unknown as SessionRepository;
		const query = new GetSessionLog(repo);
		const result = await query.execute("mbrooks", "tars", 999);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("not_found");
		}
	});
});
