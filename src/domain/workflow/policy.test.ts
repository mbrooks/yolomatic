import { describe, expect, it } from "vitest";
import {
	hasLabel,
	hasAnyLabel,
	isAssignedToYeetomatic,
	isAdmin,
	shouldIgnoreIssueEvent,
	shouldIgnoreCommentEvent,
	isStopCommand,
	isIssueRefinementCommand,
	canPause,
	canResume,
	canRestart,
	canDelete,
	formatUptime,
	DO_NOT_WORK_LABELS,
	isAdminPermission,
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
		expect(hasAnyLabel([{ name: "bug" }, { name: "yeetomatic" }], ["yeetomatic", "yeetomatic-working"])).toBe(true);
	});

	it("returns false when no labels match", () => {
		expect(hasAnyLabel([{ name: "bug" }], ["yeetomatic"])).toBe(false);
	});
});

describe("DO_NOT_WORK_LABELS", () => {
	it("contains wontfix and invalid", () => {
		expect(DO_NOT_WORK_LABELS).toContain("wontfix");
		expect(DO_NOT_WORK_LABELS).toContain("invalid");
	});
});

describe("isAssignedToYeetomatic", () => {
	it("returns true when assignee matches", () => {
		expect(isAssignedToYeetomatic({ assignee: { login: "yeetomatic-bot" } }, "yeetomatic-bot")).toBe(true);
	});

	it("returns true when assignees include match", () => {
		expect(isAssignedToYeetomatic({ assignees: [{ login: "yeetomatic-bot" }] }, "yeetomatic-bot")).toBe(true);
	});

	it("returns false when no match", () => {
		expect(isAssignedToYeetomatic({ assignees: [{ login: "other" }] }, "yeetomatic-bot")).toBe(false);
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

describe("isAdminPermission", () => {
	it("returns true for admin permission", () => {
		expect(isAdminPermission("admin")).toBe(true);
	});

	it("returns false for non-admin permissions", () => {
		expect(isAdminPermission("maintain")).toBe(false);
		expect(isAdminPermission("write")).toBe(false);
		expect(isAdminPermission("triage")).toBe(false);
		expect(isAdminPermission("read")).toBe(false);
	});

	it("returns false for null or undefined", () => {
		expect(isAdminPermission(null)).toBe(false);
		expect(isAdminPermission(undefined)).toBe(false);
	});
});

describe("shouldIgnoreIssueEvent", () => {
	it("ignores events from the bot itself", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "opened",
				issue: { assignees: [{ login: "yeetomatic-bot" }] },
				sender: { login: "yeetomatic-bot" },
			},
			"yeetomatic-bot",
			false,
		);
		expect(result.ignore).toBe(true);
	});

	it("ignores opened events not assigned to Yeetomatic", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "opened",
				issue: { assignees: [] },
				sender: { login: "user" },
			},
			"yeetomatic-bot",
			false,
		);
		expect(result.ignore).toBe(true);
	});

	it("ignores unassigned when Yeetomatic is still assigned", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "unassigned",
				issue: { assignees: [{ login: "yeetomatic-bot" }] },
				sender: { login: "user" },
			},
			"yeetomatic-bot",
			false,
		);
		expect(result.ignore).toBe(true);
	});

	it("ignores in-flight duplicates", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "opened",
				issue: { assignees: [{ login: "yeetomatic-bot" }] },
				sender: { login: "user" },
			},
			"yeetomatic-bot",
			true,
		);
		expect(result.ignore).toBe(true);
	});

	it("allows opened events assigned to Yeetomatic", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "opened",
				issue: { assignees: [{ login: "yeetomatic-bot" }] },
				sender: { login: "user" },
			},
			"yeetomatic-bot",
			false,
		);
		expect(result.ignore).toBe(false);
	});

	it("ignores issues with do-not-work labels", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "opened",
				issue: { assignees: [{ login: "yeetomatic-bot" }], labels: [{ name: "wontfix" }] },
				sender: { login: "user" },
			},
			"yeetomatic-bot",
			false,
		);
		expect(result.ignore).toBe(true);
		expect(result.ignore ? result.reason : "").toBe("issue marked do-not-work");
	});

	it("ignores issues with invalid label", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "assigned",
				issue: { assignees: [{ login: "yeetomatic-bot" }], labels: [{ name: "invalid" }] },
				sender: { login: "user" },
			},
			"yeetomatic-bot",
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
				issue: { labels: [], assignees: [{ login: "yeetomatic-bot" }] },
			},
			"yeetomatic-bot",
		);
		expect(result.ignore).toBe(true);
	});

	it("ignores comments on closed issues", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "@yeetomatic-bot please continue", user: { login: "user" } },
				issue: {
					state: "closed",
					labels: [{ name: "yeetomatic" }],
					assignees: [{ login: "yeetomatic-bot" }],
					user: { login: "yeetomatic-bot" },
				},
			},
			"yeetomatic-bot",
		);
		expect(result).toEqual({ ignore: true, reason: "issue is closed" });
	});

	it("ignores comments from the bot", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "hello", user: { login: "yeetomatic-bot" } },
				issue: { labels: [], assignees: [{ login: "yeetomatic-bot" }] },
			},
			"yeetomatic-bot",
		);
		expect(result.ignore).toBe(true);
	});

	it("ignores bot comments by type", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "hello", user: { login: "github-actions", type: "Bot" } },
				issue: { labels: [], assignees: [{ login: "yeetomatic-bot" }] },
			},
			"yeetomatic-bot",
		);
		expect(result.ignore).toBe(true);
	});

	it("ignores comments when Yeetomatic is not assigned", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "hello", user: { login: "user" } },
				issue: { labels: [], assignees: [] },
			},
			"yeetomatic-bot",
		);
		expect(result).toEqual({ ignore: true, reason: "not assigned to yeetomatic-bot" });
	});

	it("allows comments that mention the bot", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "Hey @yeetomatic-bot", user: { login: "user" } },
				issue: { labels: [], assignees: [{ login: "yeetomatic-bot" }] },
			},
			"yeetomatic-bot",
		);
		expect(result.ignore).toBe(false);
		if (!result.ignore) {
			expect(result.isMentioned).toBe(true);
		}
	});

	it("ignores mentions when github_username does not match the assignee", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "@yeetomatic please help", user: { login: "user" } },
				issue: { labels: [{ name: "yeetomatic" }], assignees: [{ login: "yeetomaticmbrooks" }] },
			},
			"mbrooks",
		);
		expect(result).toEqual({ ignore: true, reason: "not assigned to mbrooks" });
	});

	it("ignores comments on Yeetomatic-created issues when Yeetomatic is not assigned", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "hello", user: { login: "user" } },
				issue: { labels: [{ name: "yeetomatic" }], assignees: [], user: { login: "yeetomatic-bot" } },
			},
			"yeetomatic-bot",
		);
		expect(result).toEqual({ ignore: true, reason: "not assigned to yeetomatic-bot" });
	});
});

describe("isIssueRefinementCommand", () => {
	it("accepts the exact command", () => {
		expect(isIssueRefinementCommand("/yeetomatic issue-refinement")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isIssueRefinementCommand("/Yeetomatic Issue-Refinement")).toBe(true);
	});

	it("rejects suffixes and arguments", () => {
		expect(isIssueRefinementCommand("/yeetomatic issue-refinement please")).toBe(false);
		expect(isIssueRefinementCommand("/yeetomatic issue-refinement --verbose")).toBe(false);
	});

	it("rejects embedded commands", () => {
		expect(isIssueRefinementCommand("Please run /yeetomatic issue-refinement")).toBe(false);
		expect(isIssueRefinementCommand("`/yeetomatic issue-refinement`")).toBe(false);
	});
});

describe("isStopCommand", () => {
	it("matches exact /yeetomatic stop", () => {
		expect(isStopCommand("/yeetomatic stop")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isStopCommand("/Yeetomatic STOP")).toBe(true);
	});

	it("ignores extra text", () => {
		expect(isStopCommand("/yeetomatic stop now")).toBe(false);
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
