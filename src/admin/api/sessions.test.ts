import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSessionLog, sendSessionCommand, SESSION_ACTIONS } from "./sessions.js";
import type { Session } from "../app/types.js";

vi.mock("./client.js", () => ({
	apiGet: vi.fn(),
	apiPost: vi.fn(),
}));

import { apiGet, apiPost } from "./client.js";

function session(overrides: Partial<Session> = {}): Session {
	return {
		owner: "mbrooks",
		repo: "yeetomatic",
		issueNumber: 42,
		status: "working",
		...overrides,
	} as Session;
}

describe("sessions api", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("fetchSessionLog", () => {
		it("GETs the session log endpoint without a since cursor", async () => {
			vi.mocked(apiGet).mockResolvedValueOnce({ entries: [] });

			await fetchSessionLog("mbrooks", "yeetomatic", 42);

			expect(apiGet).toHaveBeenCalledWith("/api/sessions/mbrooks/yeetomatic/42/implementation/log");
		});

		it("appends the encoded since cursor when provided", async () => {
			vi.mocked(apiGet).mockResolvedValueOnce({ entries: [] });

			await fetchSessionLog("mbrooks", "yeetomatic", 42, "2026-01-01T00:00:00Z");

			expect(apiGet).toHaveBeenCalledWith(
				"/api/sessions/mbrooks/yeetomatic/42/implementation/log?since=2026-01-01T00%3A00%3A00Z",
			);
		});

		it("URL-encodes owner and repo", async () => {
			vi.mocked(apiGet).mockResolvedValueOnce({ entries: [] });

			await fetchSessionLog("my org", "my/repo", 1);

			expect(apiGet).toHaveBeenCalledWith("/api/sessions/my%20org/my%2Frepo/1/implementation/log");
		});

		it("includes refinement kind in the session log path", async () => {
			vi.mocked(apiGet).mockResolvedValueOnce({ entries: [] });
			await fetchSessionLog("mbrooks", "yeetomatic", 42, "refinement");
			expect(apiGet).toHaveBeenCalledWith("/api/sessions/mbrooks/yeetomatic/42/refinement/log");
		});
	});

	describe("sendSessionCommand", () => {
		it("POSTs the command and returns ok with the server message", async () => {
			vi.mocked(apiPost).mockResolvedValueOnce({ message: "stopped" });

			const result = await sendSessionCommand("mbrooks", "yeetomatic", 42, { type: "cancel" });

			expect(result).toEqual({ ok: true, message: "stopped" });
			expect(apiPost).toHaveBeenCalledWith("/api/sessions/mbrooks/yeetomatic/42/implementation/commands", {
				command: "cancel",
				payload: undefined,
			});
		});

		it("falls back to a default message when the server omits one", async () => {
			vi.mocked(apiPost).mockResolvedValueOnce({});

			const result = await sendSessionCommand("mbrooks", "yeetomatic", 42, { type: "pause" });

			expect(result).toEqual({ ok: true, message: "Done." });
		});

		it("includes confirmDirty payload for prune-worktree and defaults it to true", async () => {
			vi.mocked(apiPost).mockResolvedValueOnce({ message: "pruned" });

			await sendSessionCommand("mbrooks", "yeetomatic", 42, { type: "prune-worktree" });

			expect(apiPost).toHaveBeenCalledWith("/api/sessions/mbrooks/yeetomatic/42/implementation/commands", {
				command: "prune-worktree",
				payload: { confirmDirty: true },
			});
		});

		it("returns an error result when the request throws", async () => {
			vi.mocked(apiPost).mockRejectedValueOnce(new Error("boom"));

			const result = await sendSessionCommand("mbrooks", "yeetomatic", 42, { type: "delete" });

			expect(result).toEqual({ ok: false, message: "boom" });
		});

		it("URL-encodes owner/repo in the command path", async () => {
			vi.mocked(apiPost).mockResolvedValueOnce({ message: "ok" });

			await sendSessionCommand("my org", "my/repo", 9, { type: "archive" });

			expect(apiPost).toHaveBeenCalledWith("/api/sessions/my%20org/my%2Frepo/9/implementation/commands", {
				command: "archive",
				payload: undefined,
			});
		});
	});

	describe("SESSION_ACTIONS", () => {
		it("stop action prompts to stop Yeetomatic and is visible for active statuses", () => {
			const stop = SESSION_ACTIONS.find((a) => a.key === "cancel")!;
			expect(stop.label).toBe("Stop");
			expect(stop.confirmMessage(session({ status: "working" }))).toBe(
				"Stop Yeetomatic on mbrooks/yeetomatic#42?",
			);
			expect(stop.command(session())).toEqual({ type: "cancel" });
			expect(stop.visible("working")).toBe(true);
			expect(stop.visible("pending")).toBe(true);
			expect(stop.visible("waiting-feedback")).toBe(true);
			expect(stop.visible("paused")).toBe(false);
		});

		it("pause action prompts to pause Yeetomatic and is visible for pausable statuses", () => {
			const pause = SESSION_ACTIONS.find((a) => a.key === "pause")!;
			expect(pause.confirmMessage(session())).toBe("Pause Yeetomatic on mbrooks/yeetomatic#42?");
			expect(pause.command(session())).toEqual({ type: "pause" });
			expect(pause.visible("working")).toBe(true);
			expect(pause.visible("waiting-feedback")).toBe(true);
			expect(pause.visible("paused")).toBe(false);
		});

		it("resume action prompts to resume Yeetomatic and is visible only when paused", () => {
			const resume = SESSION_ACTIONS.find((a) => a.key === "resume")!;
			expect(resume.confirmMessage(session())).toBe("Resume Yeetomatic on mbrooks/yeetomatic#42?");
			expect(resume.command(session())).toEqual({ type: "resume" });
			expect(resume.visible("paused")).toBe(true);
			expect(resume.visible("working")).toBe(false);
		});

		it("restart action resets the workspace and is visible for failed/cancelled", () => {
			const restart = SESSION_ACTIONS.find((a) => a.key === "restart")!;
			expect(restart.confirmMessage(session())).toBe(
				"This will reset the workspace and re-queue the session for mbrooks/yeetomatic#42. Proceed?",
			);
			expect(restart.command(session())).toEqual({ type: "restart" });
			expect(restart.visible("failed")).toBe(true);
			expect(restart.visible("cancelled")).toBe(true);
			expect(restart.visible("working")).toBe(false);
		});

		it("delete action is visible for terminal statuses", () => {
			const del = SESSION_ACTIONS.find((a) => a.key === "delete")!;
			expect(del.confirmMessage(session())).toBe(
				"Delete session and workspace for mbrooks/yeetomatic#42? This cannot be undone.",
			);
			expect(del.command(session())).toEqual({ type: "delete" });
			expect(del.visible("complete")).toBe(true);
			expect(del.visible("failed")).toBe(true);
			expect(del.visible("working")).toBe(false);
		});

		it("mark-failed action is visible for any non-failed status", () => {
			const markFailed = SESSION_ACTIONS.find((a) => a.key === "mark-failed")!;
			expect(markFailed.confirmMessage(session())).toBe("Mark mbrooks/yeetomatic#42 failed?");
			expect(markFailed.command(session())).toEqual({ type: "mark-failed" });
			expect(markFailed.visible("working")).toBe(true);
			expect(markFailed.visible("failed")).toBe(false);
		});

		it("mark-complete action is visible for any non-complete status", () => {
			const markComplete = SESSION_ACTIONS.find((a) => a.key === "mark-complete")!;
			expect(markComplete.confirmMessage(session())).toBe("Mark mbrooks/yeetomatic#42 complete?");
			expect(markComplete.command(session())).toEqual({ type: "mark-complete" });
			expect(markComplete.visible("working")).toBe(true);
			expect(markComplete.visible("complete")).toBe(false);
		});

		it("archive action is always visible", () => {
 {
			const archive = SESSION_ACTIONS.find((a) => a.key === "archive")!;
			expect(archive.confirmMessage(session())).toBe(
				"Archive mbrooks/yeetomatic#42? Session files will be moved to archive directory.",
			);
			expect(archive.command(session())).toEqual({ type: "archive" });
			expect(archive.visible("complete")).toBe(true);
			expect(archive.visible("working")).toBe(true);
		}
		});

		it("prune-worktree action includes confirmDirty and is always visible", () => {
			const prune = SESSION_ACTIONS.find((a) => a.key === "prune-worktree")!;
			expect(prune.confirmMessage(session())).toBe("Prune worktree for mbrooks/yeetomatic#42?");
			expect(prune.command(session())).toEqual({ type: "prune-worktree", confirmDirty: true });
			expect(prune.visible("complete")).toBe(true);
			expect(prune.visible("working")).toBe(true);
		});
	});
});
