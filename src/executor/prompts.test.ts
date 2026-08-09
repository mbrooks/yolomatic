import { describe, expect, it } from "vitest";

import { buildFeedbackPrompt, buildIssuePrompt, buildIssueRefinementPrompt, buildPRReviewPrompt, buildStatusCorrectionPrompt, formatPriorDiscussion } from "./prompts.js";

describe("buildIssuePrompt", () => {
	it("includes issue metadata", () => {
		const state = {
			issueNumber: 42,
			owner: "mbrooks",
			repo: "yolomatic",
			workspacePath: "/tmp/ws",
			title: "Fix bug",
			body: "Description here",
		} as never;
		const prompt = buildIssuePrompt(state);
		expect(prompt).toContain("#42");
		expect(prompt).toContain("mbrooks/yolomatic");
		expect(prompt).toContain("/tmp/ws");
		expect(prompt).toContain("Fix bug");
		expect(prompt).toContain("Description here");
	});

	it("handles empty body", () => {
		const state = {
			issueNumber: 1,
			owner: "x",
			repo: "y",
			workspacePath: "/tmp",
			title: "T",
			body: "",
		} as never;
		const prompt = buildIssuePrompt(state);
		expect(prompt).toContain("(no description provided)");
	});
});

describe("buildFeedbackPrompt", () => {
	it("includes feedback text", () => {
		const prompt = buildFeedbackPrompt("Please retry.");
		expect(prompt).toContain("Please retry.");
		expect(prompt).toContain("Human feedback received");
	});

	it("trims feedback text", () => {
		const prompt = buildFeedbackPrompt("  trim me  ");
		expect(prompt).toContain("trim me");
		expect(prompt).not.toContain("  trim me  ");
	});
});

describe("buildStatusCorrectionPrompt", () => {
	it("contains all three allowed markers", () => {
		const prompt = buildStatusCorrectionPrompt();
		expect(prompt).toContain("YOLO_STATUS: working");
		expect(prompt).toContain("YOLO_STATUS: waiting-feedback");
		expect(prompt).toContain("YOLO_STATUS: complete");
		expect(prompt).not.toContain(["YEETO", "MATIC_STATUS"].join(""));
	});

	it("explains that the previous response was rejected for lacking a marker", () => {
		const prompt = buildStatusCorrectionPrompt();
		expect(prompt).toContain("rejected");
		expect(prompt).toContain("valid status marker");
	});

	it("requires the marker on the first line", () => {
		const prompt = buildStatusCorrectionPrompt();
		expect(prompt).toContain("first line");
	});

	it("forbids additional work and delivery by the worker", () => {
		const prompt = buildStatusCorrectionPrompt();
		expect(prompt).toContain("Do not repeat implementation work");
		expect(prompt).toContain("do not modify any files");
		expect(prompt).toContain("do not commit");
		expect(prompt).toContain("do not push");
		expect(prompt).toContain("do not open a pull request");
		expect(prompt).toContain("control plane owns delivery");
	});

	it("warns against inferring status from prose or Markdown", () => {
		const prompt = buildStatusCorrectionPrompt();
		expect(prompt).toContain("Do not infer a status");
		expect(prompt).toContain("Status: complete");
	});
});

describe("buildPRReviewPrompt", () => {
	it("includes PR and issue metadata", () => {
		const state = {
			issueNumber: 56,
			owner: "mbrooks",
			repo: "yolomatic",
			workspacePath: "/tmp/ws",
			title: "Fix bug",
			body: "Description here",
		} as never;
		const prompt = buildPRReviewPrompt(state, [{ body: "Fix typo", user: "reviewer", path: "src/foo.ts", line: 42 }]);
		expect(prompt).toContain("PR review feedback received");
		expect(prompt).toContain("issue #56");
		expect(prompt).toContain("mbrooks/yolomatic");
		expect(prompt).toContain("yolomatic/issue-56");
		expect(prompt).toContain("Fix typo");
		expect(prompt).toContain("src/foo.ts:42");
	});

	it("includes review body when provided", () => {
		const state = {
			issueNumber: 1,
			owner: "x",
			repo: "y",
			workspacePath: "/tmp",
			title: "T",
			body: "B",
		} as never;
		const prompt = buildPRReviewPrompt(state, [], "Please add tests");
		expect(prompt).toContain("Overall review comment:");
		expect(prompt).toContain("Please add tests");
	});

	it("handles comments without line info", () => {
		const state = {
			issueNumber: 2,
			owner: "a",
			repo: "b",
			workspacePath: "/tmp",
			title: "T",
			body: "B",
		} as never;
		const prompt = buildPRReviewPrompt(state, [{ body: "LGTM", user: "user" }]);
		expect(prompt).toContain("@user: LGTM");
		expect(prompt).not.toContain("undefined");
	});

	it("handles empty comments and no review body", () => {
		const state = {
			issueNumber: 3,
			owner: "a",
			repo: "b",
			workspacePath: "/tmp",
			title: "T",
			body: "B",
		} as never;
		const prompt = buildPRReviewPrompt(state, []);
		expect(prompt).toContain("Address the review feedback");
		expect(prompt).not.toContain("Overall review comment:");
		expect(prompt).not.toContain("Review comments:");
	});

	it("does not instruct the worker to push", () => {
		const state = {
			issueNumber: 56,
			owner: "mbrooks",
			repo: "yolomatic",
			workspacePath: "/tmp/ws",
			title: "Fix bug",
			body: "Description here",
		} as never;
		const prompt = buildPRReviewPrompt(state, []);
		expect(prompt).not.toContain("git push");
		expect(prompt).not.toContain("push origin");
		expect(prompt).toContain("commit");
		expect(prompt).toContain("Do NOT push");
		expect(prompt).toContain("control plane owns delivery");
	});
});

describe("buildIssueRefinementPrompt", () => {
	it("includes issue metadata and asks for JSON output", () => {
		const state = {
			issueNumber: 7,
			owner: "mbrooks",
			repo: "yolomatic",
			workspacePath: "/tmp/ws",
			title: "Refine me",
			body: "Original body",
		} as never;
		const prompt = buildIssueRefinementPrompt(state);
		expect(prompt).toContain("issue #7");
		expect(prompt).toContain("Refine me");
		expect(prompt).toContain("Original body");
		expect(prompt).toContain("proposedTaskBody");
		expect(prompt).toContain("Do NOT commit");
	});

	it("lists proposedTitle as an optional field in the JSON contract", () => {
		const state = {
			issueNumber: 7,
			owner: "mbrooks",
			repo: "yolomatic",
			workspacePath: "/tmp/ws",
			title: "Refine me",
			body: "Original body",
		} as never;
		const prompt = buildIssueRefinementPrompt(state);
		expect(prompt).toContain('"proposedTitle"');
		expect(prompt).toContain("omit or empty to keep the original");
		expect(prompt).toContain("proposedTaskBody");
		expect(prompt).toContain("investigation");
	});

	it("includes repository skill content when provided", () => {
		const state = {
			issueNumber: 8,
			owner: "mbrooks",
			repo: "yolomatic",
			workspacePath: "/tmp/ws",
			title: "T",
			body: "B",
		} as never;
		const prompt = buildIssueRefinementPrompt(state, "Skill instructions");
		expect(prompt).toContain("Skill instructions");
		expect(prompt).toContain("Repository skill instructions");
	});

	it("falls back text when no skill is provided", () => {
		const state = {
			issueNumber: 9,
			owner: "mbrooks",
			repo: "yolomatic",
			workspacePath: "/tmp/ws",
			title: "T",
			body: "B",
		} as never;
		const prompt = buildIssueRefinementPrompt(state);
		expect(prompt).toContain("built-in");
	});

	describe("steering prompt", () => {
		const state = {
			issueNumber: 10,
			owner: "mbrooks",
			repo: "yolomatic",
			workspacePath: "/tmp/ws",
			title: "T",
			body: "B",
		} as never;

		it("is byte-for-byte identical when no steering prompt is supplied", () => {
			const baseline = buildIssueRefinementPrompt(state);
			expect(buildIssueRefinementPrompt(state, undefined)).toBe(baseline);
			expect(buildIssueRefinementPrompt(state, undefined, "")).toBe(baseline);
			expect(buildIssueRefinementPrompt(state, undefined, "   ")).toBe(baseline);
		});

		it("adds a labeled authoritative steering section when a prompt is provided", () => {
			const prompt = buildIssueRefinementPrompt(state, undefined, "Focus on rollback");
			expect(prompt).toContain("Steering prompt from the requesting maintainer (authoritative for this pass):");
			expect(prompt).toContain("Focus on rollback");
			expect(prompt).toContain("Treat the steering prompt as authoritative guidance");
		});

		it("places the steering section after the skill section and before the original issue", () => {
			const prompt = buildIssueRefinementPrompt(state, "Skill instructions", "Focus on rollback");
			const skillIdx = prompt.indexOf("Skill instructions");
			const steeringIdx = prompt.indexOf("Steering prompt from the requesting maintainer");
			const titleIdx = prompt.indexOf("Original issue title:");
			expect(skillIdx).toBeLessThan(steeringIdx);
			expect(steeringIdx).toBeLessThan(titleIdx);
		});
	});
});

describe("buildFeedbackPrompt prior discussion", () => {
	it("renders a Prior discussion section above the triggering comment", () => {
		const prompt = buildFeedbackPrompt("Please retry.", [
			{ author: "mbrooks", body: "I think the tests are flaky." },
			{ author: "tarsmbrooks", body: "Agreed, rerun." },
		]);
		expect(prompt).toContain("Prior discussion");
		expect(prompt).toContain("@mbrooks:");
		expect(prompt).toContain("I think the tests are flaky.");
		expect(prompt).toContain("@tarsmbrooks:");
		expect(prompt).toContain("Agreed, rerun.");
		// Triggering comment still present
		expect(prompt).toContain("Please retry.");
		const priorIdx = prompt.indexOf("Prior discussion");
		const triggerIdx = prompt.indexOf("Please retry.");
		expect(priorIdx).toBeLessThan(triggerIdx);
	});

	it("omits the Prior discussion section when no prior comments are provided", () => {
		const prompt = buildFeedbackPrompt("Please retry.");
		expect(prompt).not.toContain("Prior discussion");
		expect(prompt).toContain("Please retry.");
	});

	it("omits the Prior discussion section when the list is empty", () => {
		const prompt = buildFeedbackPrompt("Please retry.", []);
		expect(prompt).not.toContain("Prior discussion");
	});

	it("trims prior comment bodies", () => {
		const prompt = buildFeedbackPrompt("Retry.", [
			{ author: "mbrooks", body: "  surround me  " },
		]);
		expect(prompt).toContain("surround me");
		expect(prompt).not.toContain("  surround me  ");
	});
});

describe("formatPriorDiscussion", () => {
	it("returns an empty string when there are no prior comments", () => {
		expect(formatPriorDiscussion([])).toBe("");
	});

	it("returns a delimited section with author and body", () => {
		const text = formatPriorDiscussion([{ author: "mbrooks", body: "Hello" }]);
		expect(text).toContain("Prior discussion");
		expect(text).toContain("@mbrooks:");
		expect(text).toContain("Hello");
		expect(text).toContain("---");
	});
});
