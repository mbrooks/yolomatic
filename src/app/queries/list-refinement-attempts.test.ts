import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { RefinementStore } from "../../refinement/store.js";
import { ListRefinementAttempts } from "./list-refinement-attempts.js";

describe("ListRefinementAttempts", () => {
	let tmpDir: string;
	let store: RefinementStore;
	let query: ListRefinementAttempts;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "refinement-attempts-"));
		store = new RefinementStore(path.join(tmpDir, "refinement.sqlite"));
		query = new ListRefinementAttempts(store);
	});

	afterEach(async () => {
		vi.useRealTimers();
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("returns an empty list when no attempts exist", async () => {
		const result = await query.execute("mbrooks", "yolomatic", 1);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.attempts).toEqual([]);
		}
	});

	it("returns attempts newest first with all fields", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const first = store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 1,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "applied",
			summary: "First summary",
		});
		vi.setSystemTime(new Date("2026-01-01T00:00:00.001Z"));
		const second = store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 1,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "repository-skill",
			repoCommit: "abc123",
			state: "running",
			summary: "Investigating",
			investigation: "Looked at files",
			failureReason: undefined,
		});

		const result = await query.execute("mbrooks", "yolomatic", 1);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.attempts).toHaveLength(2);
			expect(result.data.attempts[0].id).toBe(second.id);
			expect(result.data.attempts[1].id).toBe(first.id);
			expect(result.data.attempts[0].instructionSource).toBe("repository-skill");
			expect(result.data.attempts[0].repoCommit).toBe("abc123");
			expect(result.data.attempts[0].summary).toBe("Investigating");
			expect(result.data.attempts[0].investigation).toBe("Looked at files");
			expect(result.data.attempts[0].state).toBe("running");
			expect(result.data.attempts[1].summary).toBe("First summary");
		}
	});

	it("exposes runtime and token usage recorded on an attempt", async () => {
		const created = store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 4,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "repository-skill",
			state: "applied",
		});
		store.updateAttempt(created.id, {
			runtimeMs: 90_000,
			tokenUsage: { available: true, input: 100, output: 40, totalTokens: 140, cost: 0.9 },
		});

		const result = await query.execute("mbrooks", "yolomatic", 4);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.attempts[0].runtimeMs).toBe(90_000);
			expect(result.data.attempts[0].tokenUsage).toEqual({
				available: true,
				input: 100,
				output: 40,
				totalTokens: 140,
				cost: 0.9,
			});
		}
	});

	it("exposes failure reason for failed attempts", async () => {
		store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 3,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "failed",
			failureReason: "worker crashed",
		});
		const result = await query.execute("mbrooks", "yolomatic", 3);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.attempts[0].failureReason).toBe("worker crashed");
			expect(result.data.attempts[0].state).toBe("failed");
		}
	});
});
