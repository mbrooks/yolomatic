import { describe, expect, it } from "vitest";
import {
	hasLabel,
	hasAnyLabel,
	isAssignedToYolomatic,
	isAdmin,
	shouldIgnoreIssueEvent,
	shouldIgnoreCommentEvent,
	isStopCommand,
	isIssueRefinementCommand,
	parseIssueRefinementCommand,
	isFixMergeConflictsCommand,
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
		expect(hasAnyLabel([{ name: "bug" }, { name: "yolomatic" }], ["yolomatic", "yolomatic-working"])).toBe(true);
	});

	it("returns false when no labels match", () => {
		expect(hasAnyLabel([{ name: "bug" }], ["yolomatic"])).toBe(false);
	});
});

describe("DO_NOT_WORK_LABELS", () => {
	it("contains wontfix and invalid", () => {
		expect(DO_NOT_WORK_LABELS).toContain("wontfix");
		expect(DO_NOT_WORK_LABELS).toContain("invalid");
	});
});

describe("isAssignedToYolomatic", () => {
	it("returns true when assignee matches", () => {
		expect(isAssignedToYolomatic({ assignee: { login: "yolomatic-bot" } }, "yolomatic-bot")).toBe(true);
	});

	it("returns true when assignees include match", () => {
		expect(isAssignedToYolomatic({ assignees: [{ login: "yolomatic-bot" }] }, "yolomatic-bot")).toBe(true);
	});

	it("returns false when no match", () => {
		expect(isAssignedToYolomatic({ assignees: [{ login: "other" }] }, "yolomatic-bot")).toBe(false);
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
				issue: { assignees: [{ login: "yolomatic-bot" }] },
				sender: { login: "yolomatic-bot" },
			},
			"yolomatic-bot",
			false,
		);
		expect(result.ignore).toBe(true);
	});

	it("ignores opened events not assigned to Yolomatic", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "opened",
				issue: { assignees: [] },
				sender: { login: "user" },
			},
			"yolomatic-bot",
			false,
		);
		expect(result.ignore).toBe(true);
	});

	it("ignores unassigned when Yolomatic is still assigned", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "unassigned",
				issue: { assignees: [{ login: "yolomatic-bot" }] },
				sender: { login: "user" },
			},
			"yolomatic-bot",
			false,
		);
		expect(result.ignore).toBe(true);
	});

	it("ignores in-flight duplicates", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "opened",
				issue: { assignees: [{ login: "yolomatic-bot" }] },
				sender: { login: "user" },
			},
			"yolomatic-bot",
			true,
		);
		expect(result.ignore).toBe(true);
	});

	it("allows opened events assigned to Yolomatic", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "opened",
				issue: { assignees: [{ login: "yolomatic-bot" }] },
				sender: { login: "user" },
			},
			"yolomatic-bot",
			false,
		);
		expect(result.ignore).toBe(false);
	});

	it("ignores issues with do-not-work labels", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "opened",
				issue: { assignees: [{ login: "yolomatic-bot" }], labels: [{ name: "wontfix" }] },
				sender: { login: "user" },
			},
			"yolomatic-bot",
			false,
		);
		expect(result.ignore).toBe(true);
		expect(result.ignore ? result.reason : "").toBe("issue marked do-not-work");
	});

	it("ignores issues with invalid label", () => {
		const result = shouldIgnoreIssueEvent(
			{
				action: "assigned",
				issue: { assignees: [{ login: "yolomatic-bot" }], labels: [{ name: "invalid" }] },
				sender: { login: "user" },
			},
			"yolomatic-bot",
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
				issue: { labels: [], assignees: [{ login: "yolomatic-bot" }] },
			},
			"yolomatic-bot",
		);
		expect(result.ignore).toBe(true);
	});

	it("ignores comments on closed issues", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "@yolomatic-bot please continue", user: { login: "user" } },
				issue: {
					state: "closed",
					labels: [{ name: "yolomatic" }],
					assignees: [{ login: "yolomatic-bot" }],
					user: { login: "yolomatic-bot" },
				},
			},
			"yolomatic-bot",
		);
		expect(result).toEqual({ ignore: true, reason: "issue is closed" });
	});

	it("ignores comments from the bot", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "hello", user: { login: "yolomatic-bot" } },
				issue: { labels: [], assignees: [{ login: "yolomatic-bot" }] },
			},
			"yolomatic-bot",
		);
		expect(result.ignore).toBe(true);
	});

	it("ignores bot comments by type", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "hello", user: { login: "github-actions", type: "Bot" } },
				issue: { labels: [], assignees: [{ login: "yolomatic-bot" }] },
			},
			"yolomatic-bot",
		);
		expect(result.ignore).toBe(true);
	});

	it("ignores comments when Yolomatic is not assigned", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "hello", user: { login: "user" } },
				issue: { labels: [], assignees: [] },
			},
			"yolomatic-bot",
		);
		expect(result).toEqual({ ignore: true, reason: "not assigned to yolomatic-bot" });
	});

	it("allows comments that mention the bot", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "Hey @yolomatic-bot", user: { login: "user" } },
				issue: { labels: [], assignees: [{ login: "yolomatic-bot" }] },
			},
			"yolomatic-bot",
		);
		expect(result.ignore).toBe(false);
		if (!result.ignore) {
			expect(result.isMentioned).toBe(true);
			expect(result.isFeedbackCommand).toBe(false);
		}
	});

	it("accepts a /yolomatic feedback command on an assigned issue without a label", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "/yolomatic feedback please retry", user: { login: "user" } },
				issue: { labels: [], assignees: [{ login: "yolomatic-bot" }] },
			},
			"yolomatic-bot",
		);
		expect(result.ignore).toBe(false);
		if (!result.ignore) {
			expect(result.isFeedbackCommand).toBe(true);
			expect(result.isMentioned).toBe(false);
		}
	});

	it("accepts a case-insensitive /Yolomatic FEEDBACK command", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "/Yolomatic FEEDBACK", user: { login: "user" } },
				issue: { labels: [], assignees: [{ login: "yolomatic-bot" }] },
			},
			"yolomatic-bot",
		);
		expect(result.ignore).toBe(false);
		if (!result.ignore) {
			expect(result.isFeedbackCommand).toBe(true);
		}
	});

	it("ignores a /yolomatic feedback command when Yolomatic is not assigned", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "/yolomatic feedback", user: { login: "user" } },
				issue: { labels: [{ name: "yolomatic" }], assignees: [] },
			},
			"yolomatic-bot",
		);
		expect(result).toEqual({ ignore: true, reason: "not assigned to yolomatic-bot" });
	});

	it("ignores a plain comment on an assigned issue that has a Yolomatic-visible label", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "just a status check, no trigger", user: { login: "user" } },
				issue: { labels: [{ name: "yolomatic-working" }], assignees: [{ login: "yolomatic-bot" }] },
			},
			"yolomatic-bot",
		);
		expect(result).toEqual({ ignore: true, reason: "no mention or /yolomatic feedback command" });
	});

	it("ignores a mention on an unassigned issue even with a Yolomatic-visible label", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "@yolomatic please help", user: { login: "user" } },
				issue: { labels: [{ name: "yolomatic" }], assignees: [{ login: "someone-else" }] },
			},
			"yolomatic-bot",
		);
		expect(result).toEqual({ ignore: true, reason: "not assigned to yolomatic-bot" });
	});

	it("ignores mentions when github_username does not match the assignee", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "@yolomatic please help", user: { login: "user" } },
				issue: { labels: [{ name: "yolomatic" }], assignees: [{ login: "yolomaticmbrooks" }] },
			},
			"mbrooks",
		);
		expect(result).toEqual({ ignore: true, reason: "not assigned to mbrooks" });
	});

	it("ignores comments on Yolomatic-created issues when Yolomatic is not assigned", () => {
		const result = shouldIgnoreCommentEvent(
			{
				action: "created",
				comment: { body: "hello", user: { login: "user" } },
				issue: { labels: [{ name: "yolomatic" }], assignees: [], user: { login: "yolomatic-bot" } },
			},
			"yolomatic-bot",
		);
		expect(result).toEqual({ ignore: true, reason: "not assigned to yolomatic-bot" });
	});
});

describe("parseIssueRefinementCommand", () => {
	it("matches the no-argument command with an empty steering prompt", () => {
		expect(parseIssueRefinementCommand("/yolomatic issue-refinement")).toEqual({ matched: true, steeringPrompt: "" });
	});

	it("is case-insensitive for the command token", () => {
		expect(parseIssueRefinementCommand("/Yolomatic Issue-Refinement")).toEqual({ matched: true, steeringPrompt: "" });
	});

	it("extracts trailing text as the steering prompt", () => {
		expect(parseIssueRefinementCommand("/yolomatic issue-refinement Focus on rollback")).toEqual({
			matched: true,
			steeringPrompt: "Focus on rollback",
		});
	});

	it("trims leading and trailing whitespace around the comment and steering prompt", () => {
		expect(parseIssueRefinementCommand("  /yolomatic issue-refinement   focus on migration   ")).toEqual({
			matched: true,
			steeringPrompt: "focus on migration",
		});
	});

	it("treats trailing whitespace only as the empty steering prompt", () => {
		expect(parseIssueRefinementCommand("/yolomatic issue-refinement   \n\t")).toEqual({ matched: true, steeringPrompt: "" });
	});

	it("collapses multiple separators into the trimmed steering prompt", () => {
		expect(parseIssueRefinementCommand("/yolomatic issue-refinement    add    criteria")).toEqual({
			matched: true,
			steeringPrompt: "add    criteria",
		});
	});

	it("rejects embedded commands", () => {
		expect(parseIssueRefinementCommand("Please run /yolomatic issue-refinement")).toEqual({ matched: false });
	});

	it("rejects backtick-wrapped command tokens", () => {
		expect(parseIssueRefinementCommand("`/yolomatic issue-refinement`")).toEqual({ matched: false });
		expect(parseIssueRefinementCommand("` /yolomatic issue-refinement`")).toEqual({ matched: false });
	});

	it("rejects a command glued to trailing text with no separating whitespace", () => {
		expect(parseIssueRefinementCommand("/yolomatic issue-refinement--verbose")).toEqual({ matched: false });
	});

	it("rejects empty or whitespace-only bodies", () => {
		expect(parseIssueRefinementCommand("")).toEqual({ matched: false });
		expect(parseIssueRefinementCommand("   ")).toEqual({ matched: false });
	});

	it("rejects unrelated text", () => {
		expect(parseIssueRefinementCommand("hello world")).toEqual({ matched: false });
		expect(parseIssueRefinementCommand("/yolomatic stop")).toEqual({ matched: false });
	});
});

describe("isIssueRefinementCommand", () => {
	it("accepts the exact command", () => {
		expect(isIssueRefinementCommand("/yolomatic issue-refinement")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isIssueRefinementCommand("/Yolomatic Issue-Refinement")).toBe(true);
	});

	it("accepts trailing steering-prompt text as a match", () => {
		expect(isIssueRefinementCommand("/yolomatic issue-refinement please")).toBe(true);
		expect(isIssueRefinementCommand("/yolomatic issue-refinement --verbose focus")).toBe(true);
	});

	it("rejects embedded commands", () => {
		expect(isIssueRefinementCommand("Please run /yolomatic issue-refinement")).toBe(false);
		expect(isIssueRefinementCommand("`/yolomatic issue-refinement`")).toBe(false);
	});
});

describe("isStopCommand", () => {
	it("matches exact /yolomatic stop", () => {
		expect(isStopCommand("/yolomatic stop")).toBe(true);
	});

	it("strips leading and trailing whitespace before matching", () => {
		expect(isStopCommand("   /yolomatic stop   ")).toBe(true);
		expect(isStopCommand("\n/yolomatic stop\n")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isStopCommand("/Yolomatic STOP")).toBe(true);
	});

	it("ignores extra text", () => {
		expect(isStopCommand("/yolomatic stop now")).toBe(false);
	});

	it("rejects embedded commands that do not start the trimmed body", () => {
		expect(isStopCommand("please /yolomatic stop")).toBe(false);
		expect(isStopCommand("`/yolomatic stop`")).toBe(false);
	});
});

describe("isFixMergeConflictsCommand", () => {
	it("matches exact /yolomatic fix-merge-conflicts", () => {
		expect(isFixMergeConflictsCommand("/yolomatic fix-merge-conflicts")).toBe(true);
	});

	it("strips leading and trailing whitespace before matching", () => {
		expect(isFixMergeConflictsCommand("   /yolomatic fix-merge-conflicts   ")).toBe(true);
		expect(isFixMergeConflictsCommand("\n/yolomatic fix-merge-conflicts\n")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isFixMergeConflictsCommand("/Yolomatic Fix-Merge-Conflicts")).toBe(true);
		expect(isFixMergeConflictsCommand("/YOLOMATIC FIX-MERGE-CONFLICTS")).toBe(true);
	});

	it("allows trailing text after the command token", () => {
		expect(isFixMergeConflictsCommand("/yolomatic fix-merge-conflicts please")).toBe(true);
		expect(isFixMergeConflictsCommand("/yolomatic fix-merge-conflicts   \n")).toBe(true);
	});

	it("rejects embedded commands that do not start the trimmed body", () => {
		expect(isFixMergeConflictsCommand("please run /yolomatic fix-merge-conflicts")).toBe(false);
		expect(isFixMergeConflictsCommand("`/yolomatic fix-merge-conflicts`")).toBe(false);
	});

	it("rejects tokens that extend the command with non-whitespace", () => {
		expect(isFixMergeConflictsCommand("/yolomatic fix-merge-conflicts-now")).toBe(false);
		expect(isFixMergeConflictsCommand("/yolomatic fix-merge-conflictsx")).toBe(false);
	});

	it("returns false for empty or whitespace-only bodies", () => {
		expect(isFixMergeConflictsCommand("")).toBe(false);
		expect(isFixMergeConflictsCommand("   ")).toBe(false);
	});

	it("returns false for the other /yolomatic commands", () => {
		expect(isFixMergeConflictsCommand("/yolomatic stop")).toBe(false);
		expect(isFixMergeConflictsCommand("/yolomatic feedback")).toBe(false);
		expect(isFixMergeConflictsCommand("/yolomatic issue-refinement")).toBe(false);
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
	it("matches the exact /yolomatic feedback command", () => {
		expect(isFeedbackCommand("/yolomatic feedback")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isFeedbackCommand("/Yolomatic FEEDBACK")).toBe(true);
		expect(isFeedbackCommand("/YOLOMATIC Feedback")).toBe(true);
	});

	it("strips leading and trailing whitespace before matching", () => {
		expect(isFeedbackCommand("   /yolomatic feedback   ")).toBe(true);
		expect(isFeedbackCommand("\n/yolomatic feedback\n")).toBe(true);
	});

	it("accepts trailing text after the command as the feedback payload", () => {
		expect(isFeedbackCommand("/yolomatic feedback please retry")).toBe(true);
		expect(isFeedbackCommand("/yolomatic feedback\nplease retry now")).toBe(true);
	});

	it("rejects embedded commands that do not start the trimmed body", () => {
		expect(isFeedbackCommand("Please /yolomatic feedback now")).toBe(false);
		expect(isFeedbackCommand("run /yolomatic feedback")).toBe(false);
	});

	it("rejects backtick-wrapped command tokens", () => {
		expect(isFeedbackCommand("`/yolomatic feedback`")).toBe(false);
		expect(isFeedbackCommand("` /yolomatic feedback`")).toBe(false);
	});

	it("rejects bodies without the command", () => {
		expect(isFeedbackCommand("@yolomatic please help")).toBe(false);
		expect(isFeedbackCommand("/yolomatic stop")).toBe(false);
		expect(isFeedbackCommand("/yolomatic issue-refinement")).toBe(false);
		expect(isFeedbackCommand("just a comment")).toBe(false);
	});

	it("does not match /yolomaticfeedback without the separating space", () => {
		expect(isFeedbackCommand("/yolomaticfeedback")).toBe(false);
		expect(isFeedbackCommand("/yolomatic feedbacknow")).toBe(false);
	});

	it("rejects empty or whitespace-only bodies", () => {
		expect(isFeedbackCommand("")).toBe(false);
		expect(isFeedbackCommand("   ")).toBe(false);
	});
});

describe("commentTriggersFeedback", () => {
	it("returns true for a mention of the configured account", () => {
		expect(commentTriggersFeedback("Hey @yolomatic-bot", "yolomatic-bot")).toBe(true);
	});

	it("returns true for an @yolomatic mention regardless of configured account", () => {
		expect(commentTriggersFeedback("Hey @yolomatic", "mbrooks")).toBe(true);
	});

	it("returns true for the /yolomatic feedback command", () => {
		expect(commentTriggersFeedback("/yolomatic feedback", "yolomatic-bot")).toBe(true);
	});

	it("returns true for the feedback command with trailing text", () => {
		expect(commentTriggersFeedback("/yolomatic feedback please retry", "yolomatic-bot")).toBe(true);
	});

	it("returns false for an embedded feedback command", () => {
		expect(commentTriggersFeedback("Please run /yolomatic feedback", "yolomatic-bot")).toBe(false);
	});

	it("returns false for a plain comment with no trigger", () => {
		expect(commentTriggersFeedback("just a status check", "yolomatic-bot")).toBe(false);
	});

	it("returns false for the stop command", () => {
		expect(commentTriggersFeedback("/yolomatic stop", "yolomatic-bot")).toBe(false);
	});

	it("is case-insensitive for @yolomatic", () => {
		expect(commentTriggersFeedback("HEY @YOLOMATIC", "mbrooks")).toBe(true);
	});
});
