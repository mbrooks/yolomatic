import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStoreRepositoryAdapter } from "./session-store-repository-adapter.js";
import { SessionStore } from "../../session/store.js";

describe("SessionStoreRepositoryAdapter", () => {
	let tmpDir: string;
	let store: SessionStore;
	let adapter: SessionStoreRepositoryAdapter;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "session-repo-"));
		store = new SessionStore(path.join(tmpDir, "sessions.sqlite"), tmpDir);
		adapter = new SessionStoreRepositoryAdapter(store);
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	describe("createSession", () => {
		it("creates a new pending session", async () => {
			const state = await adapter.createSession(
				"mbrooks",
				"yeetomatic",
				42,
				"Test issue",
				"Test body",
				"/tmp/workspaces/mbrooks-yeetomatic/.worktrees/issue-42",
				["bug"],
			);
			expect(state.owner).toBe("mbrooks");
			expect(state.repo).toBe("yeetomatic");
			expect(state.issueNumber).toBe(42);
			expect(state.status).toBe("pending");
			expect(state.seeded).toBe(false);
			expect(state.labels).toEqual(["bug"]);
			expect(await store.get("mbrooks", "yeetomatic", 42)).toEqual(state);
		});

		it("returns an existing session without overwriting", async () => {
			const first = await adapter.createSession(
				"mbrooks",
				"yeetomatic",
				42,
				"First",
				"First body",
				"/tmp/workspaces/mbrooks-yeetomatic/.worktrees/issue-42",
			);
			const second = await adapter.createSession(
				"mbrooks",
				"yeetomatic",
				42,
				"Second",
				"Second body",
				"/tmp/workspaces/mbrooks-yeetomatic/.worktrees/issue-42",
			);
			expect(second).toEqual(first);
		});
	});

	describe("get", () => {
		it("returns null when session does not exist", async () => {
			expect(await adapter.get("mbrooks", "yeetomatic", 42)).toBeNull();
		});

		it("returns the created session", async () => {
			const state = await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			expect(await adapter.get("mbrooks", "yeetomatic", 42)).toEqual(state);
		});
	});

	describe("getAll", () => {
		it("returns all non-archived sessions", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "A", "B", "/tmp/ws");
			await adapter.createSession("mbrooks", "case", 1, "C", "D", "/tmp/ws2");
			const all = await adapter.getAll();
			expect(all).toHaveLength(2);
		});
	});

	describe("updateStatus", () => {
		it("updates status and lastActivity", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			const updated = await adapter.updateStatus("mbrooks", "yeetomatic", 42, "working");
			expect(updated.status).toBe("working");
			expect(updated.lastActivity).toBeTruthy();
		});

		it("throws when session does not exist", async () => {
			await expect(adapter.updateStatus("mbrooks", "yeetomatic", 42, "working")).rejects.toThrow(
				"No session for mbrooks/yeetomatic#42",
			);
		});
	});

	describe("markSeeded", () => {
		it("marks the session as seeded", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			const updated = await adapter.markSeeded("mbrooks", "yeetomatic", 42);
			expect(updated.seeded).toBe(true);
		});

		it("throws when session does not exist", async () => {
			await expect(adapter.markSeeded("mbrooks", "yeetomatic", 42)).rejects.toThrow("No session for mbrooks/yeetomatic#42");
		});
	});

	describe("associatePR", () => {
		it("sets prNumber and prUrl", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			const updated = await adapter.associatePR("mbrooks", "yeetomatic", 42, 123, "https://github.com/mbrooks/yeetomatic/pull/123");
			expect(updated.prNumber).toBe(123);
			expect(updated.prUrl).toBe("https://github.com/mbrooks/yeetomatic/pull/123");
		});

		it("throws when session does not exist", async () => {
			await expect(adapter.associatePR("mbrooks", "yeetomatic", 42, 1, "url")).rejects.toThrow(
				"No session for mbrooks/yeetomatic#42",
			);
		});
	});

	describe("incrementIterationCount", () => {
		it("increments from zero by default", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			const updated = await adapter.incrementIterationCount("mbrooks", "yeetomatic", 42);
			expect(updated.iterationCount).toBe(1);
		});

		it("increments an existing count", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			await adapter.incrementIterationCount("mbrooks", "yeetomatic", 42);
			const updated = await adapter.incrementIterationCount("mbrooks", "yeetomatic", 42);
			expect(updated.iterationCount).toBe(2);
		});

		it("throws when session does not exist", async () => {
			await expect(adapter.incrementIterationCount("mbrooks", "yeetomatic", 42)).rejects.toThrow(
				"No session for mbrooks/yeetomatic#42",
			);
		});
	});

	describe("findSessionByPR", () => {
		it("finds a session by prNumber", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			await adapter.associatePR("mbrooks", "yeetomatic", 42, 123, "url");
			const found = await adapter.findSessionByPR("mbrooks", "yeetomatic", 123);
			expect(found?.issueNumber).toBe(42);
		});

		it("returns null when no session matches", async () => {
			expect(await adapter.findSessionByPR("mbrooks", "yeetomatic", 999)).toBeNull();
		});
	});

	describe("cancelSession", () => {
		it("cancels the session", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			const updated = await adapter.cancelSession("mbrooks", "yeetomatic", 42);
			expect(updated.status).toBe("cancelled");
		});
	});

	describe("pauseSession", () => {
		it("pauses an active session", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			const updated = await adapter.pauseSession("mbrooks", "yeetomatic", 42);
			expect(updated.status).toBe("paused");
		});

		it("throws when already paused", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			await adapter.pauseSession("mbrooks", "yeetomatic", 42);
			await expect(adapter.pauseSession("mbrooks", "yeetomatic", 42)).rejects.toThrow("already paused");
		});

		it("throws when terminal", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			await adapter.cancelSession("mbrooks", "yeetomatic", 42);
			await expect(adapter.pauseSession("mbrooks", "yeetomatic", 42)).rejects.toThrow("Cannot pause");
		});
	});

	describe("unpauseSession", () => {
		it("resumes a paused session", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			await adapter.pauseSession("mbrooks", "yeetomatic", 42);
			const updated = await adapter.unpauseSession("mbrooks", "yeetomatic", 42);
			expect(updated.status).toBe("pending");
		});

		it("throws when not paused", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			await expect(adapter.unpauseSession("mbrooks", "yeetomatic", 42)).rejects.toThrow("Cannot resume");
		});
	});

	describe("restartSession", () => {
		it("restarts a cancelled session", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			await adapter.cancelSession("mbrooks", "yeetomatic", 42);
			const updated = await adapter.restartSession("mbrooks", "yeetomatic", 42);
			expect(updated.status).toBe("pending");
			expect(updated.seeded).toBe(false);
			expect(updated.restartCount).toBe(1);
			expect(updated.restartedFrom).toBe("cancelled");
		});

		it("throws when session is complete", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			await adapter.updateStatus("mbrooks", "yeetomatic", 42, "complete");
			await expect(adapter.restartSession("mbrooks", "yeetomatic", 42)).rejects.toThrow("completed");
		});

		it("throws when session is not terminal", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			await expect(adapter.restartSession("mbrooks", "yeetomatic", 42)).rejects.toThrow("Cannot restart");
		});
	});

	describe("markComplete", () => {
		it("marks the session complete", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			const updated = await adapter.markComplete("mbrooks", "yeetomatic", 42);
			expect(updated.status).toBe("complete");
		});
	});

	describe("markFailed", () => {
		it("marks the session failed with a reason", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			const updated = await adapter.markFailed("mbrooks", "yeetomatic", 42, "it broke");
			expect(updated.status).toBe("failed");
			expect(updated.summary).toBe("it broke");
			expect(updated.staleDetectedAt).toBeTruthy();
		});

		it("preserves existing summary", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			await adapter.updateStatus("mbrooks", "yeetomatic", 42, "working", { summary: "existing" });
			const updated = await adapter.markFailed("mbrooks", "yeetomatic", 42, "it broke");
			expect(updated.summary).toBe("existing");
		});
	});

	describe("markStale", () => {
		it("records stale reason", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			const updated = await adapter.markStale("mbrooks", "yeetomatic", 42, "no response");
			expect(updated.staleReason).toBe("no response");
			expect(updated.staleDetectedAt).toBeTruthy();
		});

		it("throws when session does not exist", async () => {
			await expect(adapter.markStale("mbrooks", "yeetomatic", 42, "reason")).rejects.toThrow(
				"No session for mbrooks/yeetomatic#42",
			);
		});
	});

	describe("archive", () => {
		it("archives a session to the given directory", async () => {
			const state = await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			const archiveDir = path.join(tmpDir, "archive");
			await adapter.archive(state, archiveDir);
			expect(await adapter.get("mbrooks", "yeetomatic", 42)).toBeNull();
		});
	});

	describe("delete", () => {
		it("deletes the session", async () => {
			await adapter.createSession("mbrooks", "yeetomatic", 42, "T", "B", "/tmp/ws");
			await adapter.delete("mbrooks", "yeetomatic", 42);
			expect(await adapter.get("mbrooks", "yeetomatic", 42)).toBeNull();
		});
	});
});
