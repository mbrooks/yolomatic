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
	parseIssueRefinementCommand,
	canPause,
	canResume,
	canRestart,
	canDelete,
	formatUptime,
	DO_NOT_WORK_LABELS,
	isAdminPermission,
	commentTriggersFeedback,
	isFeedbackCommand,
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
			expect(result.isFeedbackCommand).toBe(false);
		}
	});

	it("accepts a /yeetomatic feedback command on an assigned issue without a label", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "/yeetomatic feedback please retry", user: { login: "user" } },
				issue: { labels: [], assignees: [{ login: "yeetomatic-bot" }] },
			},
			"yeetomatic-bot",
		);
		expect(result.ignore).toBe(false);
		if (!result.ignore) {
			expect(result.isFeedbackCommand).toBe(true);
			expect(result.isMentioned).toBe(false);
		}
	});

	it("accepts a case-insensitive /Yeetomatic FEEDBACK command", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "/Yeetomatic FEEDBACK", user: { login: "user" } },
				issue: { labels: [], assignees: [{ login: "yeetomatic-bot" }] },
			},
			"yeetomatic-bot",
		);
		expect(result.ignore).toBe(false);
		if (!result.ignore) {
			expect(result.isFeedbackCommand).toBe(true);
		}
	});

	it("ignores a /yeetomatic feedback command when Yeetomatic is not assigned", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "/yeetomatic feedback", user: { login: "user" } },
				issue: { labels: [{ name: "yeetomatic" }], assignees: [] },
			},
			"yeetomatic-bot",
		);
		expect(result).toEqual({ ignore: true, reason: "not assigned to yeetomatic-bot" });
	});

	it("ignores a plain comment on an assigned issue that has a Yeetomatic-visible label", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "just a status check, no trigger", user: { login: "user" } },
				issue: { labels: [{ name: "yeetomatic-working" }], assignees: [{ login: "yeetomatic-bot" }] },
			},
			"yeetomatic-bot",
		);
		expect(result).toEqual({ ignore: true, reason: "no mention or /yeetomatic feedback command" });
	});

	it("ignores a mention on an unassigned issue even with a Yeetomatic-visible label", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "@yeetomatic please help", user: { login: "user" } },
				issue: { labels: [{ name: "yeetomatic" }], assignees: [{ login: "someone-else" }] },
			},
			"yeetomatic-bot",
		);
		expect(result).toEqual({ ignore: true, reason: "not assigned to yeetomatic-bot" });
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

describe("parseIssueRefinementCommand", () => {
	it("matches the no-argument command with an empty steering prompt", () => {
		expect(parseIssueRefinementCommand("/yeetomatic issue-refinement")).toEqual({ matched: true, steeringPrompt: "" });
	});

	it("is case-insensitive for the command token", () => {
		expect(parseIssueRefinementCommand("/Yeetomatic Issue-Refinement")).toEqual({ matched: true, steeringPrompt: "" });
	});

	it("extracts trailing text as the steering prompt", () => {
		expect(parseIssueRefinementCommand("/yeetomatic issue-refinement Focus on rollback")).toEqual({
			matched: true,
			steeringPrompt: "Focus on rollback",
		});
	});

	it("trims leading and trailing whitespace around the comment and steering prompt", () => {
		expect(parseIssueRefinementCommand("  /yeetomatic issue-refinement   focus on migration   ")).toEqual({
			matched: true,
			steeringPrompt: "focus on migration",
		});
	});

	it("treats trailing whitespace only as the empty steering prompt", () => {
		expect(parseIssueRefinementCommand("/yeetomatic issue-refinement   \n\t")).toEqual({ matched: true, steeringPrompt: "" });
	});

	it("collapses multiple separators into the trimmed steering prompt", () => {
		expect(parseIssueRefinementCommand("/yeetomatic issue-refinement    add    criteria")).toEqual({
			matched: true,
			steeringPrompt: "add    criteria",
		});
	});

	it("rejects embedded commands", () => {
		expect(parseIssueRefinementCommand("Please run /yeetomatic issue-refinement")).toEqual({ matched: false });
	});

	it("rejects backtick-wrapped command tokens", () => {
		expect(parseIssueRefinementCommand("`/yeetomatic issue-refinement`")).toEqual({ matched: false });
		expect(parseIssueRefinementCommand("` /yeetomatic issue-refinement`")).toEqual({ matched: false });
	});

	it("rejects a command glued to trailing text with no separating whitespace", () => {
		expect(parseIssueRefinementCommand("/yeetomatic issue-refinement--verbose")).toEqual({ matched: false });
	});

	it("rejects empty or whitespace-only bodies", () => {
		expect(parseIssueRefinementCommand("")).toEqual({ matched: false });
		expect(parseIssueRefinementCommand("   ")).toEqual({ matched: false });
	});

	it("rejects unrelated text", () => {
		expect(parseIssueRefinementCommand("hello world")).toEqual({ matched: false });
		expect(parseIssueRefinementCommand("/yeetomatic stop")).toEqual({ matched: false });
	});
});

describe("isIssueRefinementCommand", () => {
	it("accepts the exact command", () => {
		expect(isIssueRefinementCommand("/yeetomatic issue-refinement")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isIssueRefinementCommand("/Yeetomatic Issue-Refinement")).toBe(true);
	});

	it("accepts trailing steering-prompt text as a match", () => {
		expect(isIssueRefinementCommand("/yeetomatic issue-refinement please")).toBe(true);
		expect(isIssueRefinementCommand("/yeetomatic issue-refinement --verbose focus")).toBe(true);
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

describe("isFeedbackCommand", () => {
	it("matches the exact /yeetomatic feedback command", () => {
		expect(isFeedbackCommand("/yeetomatic feedback")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isFeedbackCommand("/Yeetomatic FEEDBACK")).toBe(true);
		expect(isFeedbackCommand("/YEETOMATIC Feedback")).toBe(true);
	});

	it("matches as a substring anywhere in the body", () => {
		expect(isFeedbackCommand("Please /yeetomatic feedback now")).toBe(true);
	});

	it("rejects bodies without the command", () => {
		expect(isFeedbackCommand("@yeetomatic please help")).toBe(false);
		expect(isFeedbackCommand("/yeetomatic stop")).toBe(false);
		expect(isFeedbackCommand("/yeetomatic issue-refinement")).toBe(false);
		expect(isFeedbackCommand("just a comment")).toBe(false);
	});

	it("does not match /yeetomaticfeedback without the separating space", () => {
		expect(isFeedbackCommand("/yeetomaticfeedback")).toBe(false);
	});
});

describe("commentTriggersFeedback", () => {
	it("returns true for a mention of the configured account", () => {
		expect(commentTriggersFeedback("Hey @yeetomatic-bot", "yeetomatic-bot")).toBe(true);
	});

	it("returns true for an @yeetomatic mention regardless of configured account", () => {
		expect(commentTriggersFeedback("Hey @yeetomatic", "mbrooks")).toBe(true);
	});

	it("returns true for the /yeetomatic feedback command", () => {
		expect(commentTriggersFeedback("/yeetomatic feedback", "yeetomatic-bot")).toBe(true);
	});

	it("returns false for a plain comment with no trigger", () => {
		expect(commentTriggersFeedback("just a status check", "yeetomatic-bot")).toBe(false);
	});

	it("returns false for the stop command", () => {
		expect(commentTriggersFeedback("/yeetomatic stop", "yeetomatic-bot")).toBe(false);
	});

	it("is case-insensitive for @yeetomatic", () => {
		expect(commentTriggersFeedback("HEY @YEETOMATIC", "mbrooks")).toBe(true);
	});
});
