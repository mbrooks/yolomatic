import { describe, expect, it } from "vitest";
import {
	hasLabel,
	hasAnyLabel,
	isAssignedToTars,
	isAdmin,
	shouldIgnoreIssueEvent,
	shouldIgnoreCommentEvent,
	isStopCommand,
	canPause,
	canResume,
	canRestart,
	canDelete,
	formatUptime,
	DO_NOT_WORK_LABELS,
} from "./policy.js";

describe("hasLabel", () => {
	it("returns true when label exists", () => {
		expect(hasLabel([{ name: "bug" }], "bug")).toBe(true);
	});

	it("returns false when label does not exist", () => {
		expect(hasLabel([{ name: "bug" }], "feature")).toBe(false);
	});

	it("returns false for undefined labels", () => {
		expect(hasLabel(undefined, "bug")).toBe(false);
	});
});

describe("hasAnyLabel", () => {
	it("returns true when any label matches", () => {
		expect(hasAnyLabel([{ name: "bug" }, { name: "tars" }], ["tars", "tars-working"])).toBe(true);
	});

	it("returns false when no labels match", () => {
		expect(hasAnyLabel([{ name: "bug" }], ["tars"])).toBe(false);
	});
});

describe("DO_NOT_WORK_LABELS", () => {
	it("contains wontfix and invalid", () => {
		expect(DO_NOT_WORK_LABELS).toContain("wontfix");
		expect(DO_NOT_WORK_LABELS).toContain("invalid");
	});
});

describe("isAssignedToTars", () => {
	it("returns true when assignee matches", () => {
		expect(isAssignedToTars({ assignee: { login: "tars-bot" } }, "tars-bot")).toBe(true);
	});

	it("returns true when assignees include match", () => {
		expect(isAssignedToTars({ assignees: [{ login: "tars-bot" }] }, "tars-bot")).toBe(true);
	});

	it("returns false when no match", () => {
		expect(isAssignedToTars({ assignees: [{ login: "other" }] }, "tars-bot")).toBe(false);
	});
});

describe("isAdmin", () => {
	it("returns true when sender matches admin username", () => {
		expect(isAdmin("admin", "admin")).toBe(true);
	});

	it("returns false when admin username is not configured", () => {
		expect(isAdmin("admin", undefined)).toBe(false);
	});

	it("returns false for mismatch", () => {
		expect(isAdmin("user", "admin")).toBe(false);
	});
});

describe("shouldIgnoreIssueEvent", () => {
	it("ignores events from the bot itself", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "opened",
				issue: { assignees: [{ login: "tars-bot" }] },
				sender: { login: "tars-bot" },
			},
			"tars-bot",
			false,
		);
		expect(result.ignore).toBe(true);
	});

	it("ignores opened events not assigned to TARS", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "opened",
				issue: { assignees: [] },
				sender: { login: "user" },
			},
			"tars-bot",
			false,
		);
		expect(result.ignore).toBe(true);
	});

	it("ignores unassigned when TARS is still assigned", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "unassigned",
				issue: { assignees: [{ login: "tars-bot" }] },
				sender: { login: "user" },
			},
			"tars-bot",
			false,
		);
		expect(result.ignore).toBe(true);
	});

	it("ignores in-flight duplicates", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "opened",
				issue: { assignees: [{ login: "tars-bot" }] },
				sender: { login: "user" },
			},
			"tars-bot",
			true,
		);
		expect(result.ignore).toBe(true);
	});

	it("allows opened events assigned to TARS", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "opened",
				issue: { assignees: [{ login: "tars-bot" }] },
				sender: { login: "user" },
			},
			"tars-bot",
			false,
		);
		expect(result.ignore).toBe(false);
	});

	it("ignores issues with do-not-work labels", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "opened",
				issue: { assignees: [{ login: "tars-bot" }], labels: [{ name: "wontfix" }] },
				sender: { login: "user" },
			},
			"tars-bot",
			false,
		);
		expect(result.ignore).toBe(true);
		expect(result.ignore ? result.reason : "").toBe("issue marked do-not-work");
	});

	it("ignores issues with invalid label", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "assigned",
				issue: { assignees: [{ login: "tars-bot" }], labels: [{ name: "invalid" }] },
				sender: { login: "user" },
			},
			"tars-bot",
			false,
		);
		expect(result.ignore).toBe(true);
	});
});

describe("shouldIgnoreCommentEvent", () => {
	it("ignores non-created actions", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "edited",
				comment: { body: "hello", user: { login: "user" } },
				issue: { labels: [], assignees: [{ login: "tars-bot" }] },
			},
			"tars-bot",
		);
		expect(result.ignore).toBe(true);
	});

	it("ignores comments from the bot", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "hello", user: { login: "tars-bot" } },
				issue: { labels: [], assignees: [{ login: "tars-bot" }] },
			},
			"tars-bot",
		);
		expect(result.ignore).toBe(true);
	});

	it("ignores bot comments by type", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "hello", user: { login: "github-actions", type: "Bot" } },
				issue: { labels: [], assignees: [{ login: "tars-bot" }] },
			},
			"tars-bot",
		);
		expect(result.ignore).toBe(true);
	});

	it("ignores comments without assignment, creation, or mention", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "hello", user: { login: "user" } },
				issue: { labels: [], assignees: [] },
			},
			"tars-bot",
		);
		expect(result.ignore).toBe(true);
	});

	it("allows comments that mention the bot", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "Hey @tars-bot", user: { login: "user" } },
				issue: { labels: [], assignees: [] },
			},
			"tars-bot",
		);
		expect(result.ignore).toBe(false);
		if (!result.ignore) {
			expect(result.isMentioned).toBe(true);
		}
	});

	it("allows comments on issues created by TARS", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "hello", user: { login: "user" } },
				issue: { labels: [], assignees: [], user: { login: "tars-bot" } },
			},
			"tars-bot",
		);
		expect(result.ignore).toBe(false);
		if (!result.ignore) {
			expect(result.isCreatedByTars).toBe(true);
		}
	});
});

describe("isStopCommand", () => {
	it("matches exact /tars stop", () => {
		expect(isStopCommand("/tars stop")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isStopCommand("/TARS STOP")).toBe(true);
	});

	it("ignores extra text", () => {
		expect(isStopCommand("/tars stop now")).toBe(false);
	});
});

describe("canPause", () => {
	it("allows pausing a working session", () => {
		expect(canPause("working")).toEqual({ ok: true });
	});

	it("rejects pausing an already paused session", () => {
		expect(canPause("paused")).toEqual({ ok: false, reason: "Session is already paused." });
	});

	it("rejects pausing a terminal session", () => {
		expect(canPause("complete")).toEqual({ ok: false, reason: "Cannot pause a session in 'complete' status." });
	});
});

describe("canResume", () => {
	it("allows resuming a paused session", () => {
		expect(canResume("paused")).toEqual({ ok: true });
	});

	it("rejects resuming a working session", () => {
		expect(canResume("working")).toEqual({
			ok: false,
			reason: "Cannot resume a session in 'working' status. Only paused sessions can be resumed.",
		});
	});
});

describe("canRestart", () => {
	it("allows restarting a failed session", () => {
		expect(canRestart("failed")).toEqual({ ok: true });
	});

	it("rejects restarting a completed session", () => {
		expect(canRestart("complete")).toEqual({ ok: false, reason: "Cannot restart a completed session." });
	});

	it("rejects restarting a working session", () => {
		expect(canRestart("working")).toEqual({
			ok: false,
			reason: "Cannot restart session in 'working' status. Only failed or cancelled sessions can be restarted.",
		});
	});
});

describe("canDelete", () => {
	it("allows deleting a complete session", () => {
		expect(canDelete("complete")).toEqual({ ok: true });
	});

	it("rejects deleting a working session", () => {
		expect(canDelete("working")).toEqual({
			ok: false,
			reason: "Cannot delete session in 'working' status. Only terminal sessions (complete, failed, cancelled) can be deleted.",
		});
	});
});

describe("formatUptime", () => {
	it("formats short uptime", () => {
		expect(formatUptime(45)).toBe("45s");
	});

	it("includes minutes", () => {
		expect(formatUptime(125)).toBe("2m 5s");
	});

	it("includes hours and minutes", () => {
		expect(formatUptime(3665)).toBe("1h 1m 5s");
	});

	it("includes days", () => {
		expect(formatUptime(90061)).toBe("1d 1h 1m 1s");
	});
});
