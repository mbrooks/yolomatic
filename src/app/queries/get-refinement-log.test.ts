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
		const result = await query.execute("mbrooks", "yolomatic", 1);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.code).toBe("not_found");
			expect(result.message).toContain("No refinement activity");
		}
	});

	it("returns logs when a refinement attempt exists", async () => {
		store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 1,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "applied",
		});
		const key = sessionStorageKey("mbrooks", "yolomatic", 1, "refinement");
		recordSessionLog(key, { level: "info", message: "Refinement started" });
		recordSessionLog(key, { level: "info", message: "Applied refined issue body" });

		const result = await query.execute("mbrooks", "yolomatic", 1);
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
			repo: "yolomatic",
			issueNumber: 4,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "instructed",
		});
		const result = await query.execute("mbrooks", "yolomatic", 4);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.available).toBe(true);
			expect(result.data.logs).toEqual([]);
		}
	});

	it("filters logs by since timestamp", async () => {
		store.createAttempt({
			owner: "mbrooks",
			repo: "yolomatic",
			issueNumber: 2,
			requester: "admin",
			originalTitle: "T",
			originalBody: "B",
			originalBodyFingerprint: "fp",
			instructionSource: "prompt-defaults",
			state: "applied",
		});
		const key = sessionStorageKey("mbrooks", "yolomatic", 2, "refinement");
		recordSessionLog(key, { level: "info", message: "first" });
		await new Promise((r) => setTimeout(r, 10));
		const all = getSessionLogs(key);
		const since = all[0].timestamp;
		recordSessionLog(key, { level: "info", message: "second" });

		const result = await query.execute("mbrooks", "yolomatic", 2, since);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.logs).toHaveLength(1);
			expect(result.data.logs[0].message).toBe("second");
		}
	});
});
