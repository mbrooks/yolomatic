import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { RefinementStore } from "../../refinement/store.js";
import { GetRefinementLog } from "./get-refinement-log.js";
import { recordSessionLog, getSessionLogs, _resetSessionLogs } from "../../logging/session-log-store.js";
import { sessionStorageKey } from "../../session/store.js";

describe("GetRefinementLog", () => {
	let tmpDir: string;
	let store: RefinementStore;
	let query: GetRefinementLog;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "refinement-log-"));
		store = new RefinementStore(path.join(tmpDir, "refinement.sqlite"));
		query = new GetRefinementLog(store);
		_resetSessionLogs();
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
		_resetSessionLogs();
	});

	it("returns not_found when no refinement attempt exists", async () => {
		const result = await query.execute("mbrooks", "yeetomatic", 1);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("not_found");
			expect(result.message).toContain("No refinement activity");
		}
	});

	it("returns logs when a refinement attempt exists", async () => {
		store.createAttempt({
			owner: "mbrooks",
			repo: "yeetomatic",
			issueNumber: 1,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "applied",
		});
		const key = sessionStorageKey("mbrooks", "yeetomatic", 1, "refinement");
		recordSessionLog(key, { level: "info", message: "Refinement started" });
		recordSessionLog(key, { level: "info", message: "Applied refined issue body" });

		const result = await query.execute("mbrooks", "yeetomatic", 1);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.available).toBe(true);
			expect(result.data.logs).toHaveLength(2);
			expect(result.data.logs[0].message).toBe("Refinement started");
		}
	});

	it("returns an empty log list when no logs were recorded but an attempt exists", async () => {
		store.createAttempt({
			owner: "mbrooks",
			repo: "yeetomatic",
			issueNumber: 4,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "instructed",
		});
		const result = await query.execute("mbrooks", "yeetomatic", 4);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.available).toBe(true);
			expect(result.data.logs).toEqual([]);
		}
	});

	it("returns worker-detail entries in addition to orchestration entries for a refinement run", async () => {
		store.createAttempt({
			owner: "mbrooks",
			repo: "yeetomatic",
			issueNumber: 3,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "applied",
		});
		const key = sessionStorageKey("mbrooks", "yeetomatic", 3, "refinement");
		// Orchestration entries recorded by handle-issue-refinement.ts.
		recordSessionLog(key, { level: "info", message: "Refinement started" });
		recordSessionLog(key, { level: "info", message: "Created refinement attempt" });
		// Worker-detail entries recorded by PiAgentExecutor.run under the same key.
		recordSessionLog(key, {
			level: "info",
			message: "Prompt sent",
			details: { type: "prompt", length: 42 },
		});
		recordSessionLog(key, {
			level: "info",
			message: "Using model: ollama/qwen",
			details: { type: "model", provider: "ollama", modelId: "qwen", configured: null },
		});
		recordSessionLog(key, {
			level: "assistant",
			message: "investigating the issue",
			details: { type: "thinking" },
		});
		recordSessionLog(key, {
			level: "tool",
			message: "read /some/file",
			details: { type: "tool_execution_start", toolName: "read", args: {} },
		});
		recordSessionLog(key, {
			level: "info",
			message: "read done",
			details: { type: "tool_execution_end", toolName: "read", result: "ok", isError: false },
		});
		recordSessionLog(key, {
			level: "assistant",
			message: "YEETOMATIC_STATUS: working\nrefined body",
			details: { type: "response", status: "working" },
		});

		const result = await query.execute("mbrooks", "yeetomatic", 3);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.available).toBe(true);
			const detailTypes = result.data.logs
				.map((entry) => entry.details?.type)
				.filter((type): type is string => typeof type === "string");
			// Worker-detail entries are present alongside the orchestration messages.
			expect(detailTypes).toContain("prompt");
			expect(detailTypes).toContain("model");
			expect(detailTypes).toContain("thinking");
			expect(detailTypes).toContain("tool_execution_start");
			expect(detailTypes).toContain("tool_execution_end");
			expect(detailTypes).toContain("response");
			// Orchestration entries (no details.type) are still present.
			expect(result.data.logs.some((entry) => entry.message === "Refinement started")).toBe(true);
			expect(result.data.logs.some((entry) => entry.message === "Created refinement attempt")).toBe(true);
		}
	});

	it("filters logs by since timestamp", async () => {
		store.createAttempt({
			owner: "mbrooks",
			repo: "yeetomatic",
			issueNumber: 2,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "applied",
		});
		const key = sessionStorageKey("mbrooks", "yeetomatic", 2, "refinement");
		recordSessionLog(key, { level: "info", message: "first" });
		await new Promise((r) => setTimeout(r, 10));
		const all = getSessionLogs(key);
		const since = all[0].timestamp;
		recordSessionLog(key, { level: "info", message: "second" });

		const result = await query.execute("mbrooks", "yeetomatic", 2, since);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.logs).toHaveLength(1);
			expect(result.data.logs[0].message).toBe("second");
		}
	});
});
