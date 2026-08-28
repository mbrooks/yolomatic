import { describe, expect, it } from "vitest";
import { fingerprintBody } from "../../../refinement/fingerprint.js";
import {
	evaluateProposalApplicability,
	type ProposalApplicabilityInput,
} from "./proposal-policy.js";

describe("evaluateProposalApplicability", () => {
	const originalBody = "Body";
	const baseInput: ProposalApplicabilityInput = {
		currentIssue: { state: "open", title: "Test", body: originalBody },
		originalTitle: "Test",
		originalBodyFingerprint: fingerprintBody(originalBody),
		proposedTaskBody: "Refined body",
		proposedTitle: undefined,
	};

	it("applies a body-only proposal when nothing changed", () => {
		const decision = evaluateProposalApplicability(baseInput);
		expect(decision.outcome).toBe("apply");
		if (decision.outcome === "apply") {
			expect(decision.applyTitle).toBe(false);
			expect(decision.proposedTitle).toBe("");
		}
	});

	it("applies a changed title alongside the body", () => {
		const decision = evaluateProposalApplicability({
			...baseInput,
			proposedTitle: "Clearer Title",
		});
		expect(decision.outcome).toBe("apply");
		if (decision.outcome === "apply") {
			expect(decision.applyTitle).toBe(true);
			expect(decision.proposedTitle).toBe("Clearer Title");
		}
	});

	it("does not apply a title that equals the original", () => {
		const decision = evaluateProposalApplicability({
			...baseInput,
			proposedTitle: "Test",
		});
		expect(decision.outcome).toBe("apply");
		if (decision.outcome === "apply") expect(decision.applyTitle).toBe(false);
	});

	it("does not apply a blank title", () => {
		const decision = evaluateProposalApplicability({
			...baseInput,
			proposedTitle: "   ",
		});
		expect(decision.outcome).toBe("apply");
		if (decision.outcome === "apply") expect(decision.applyTitle).toBe(false);
	});

	it("marks stale when the issue closed during refinement", () => {
		const decision = evaluateProposalApplicability({
			...baseInput,
			currentIssue: { state: "closed", title: "Test", body: "Body" },
		});
		expect(decision.outcome).toBe("stale");
		if (decision.outcome === "stale") {
			expect(decision.reason).toBe("issue closed during refinement");
			expect(decision.comment).toContain("The issue changed during refinement");
			expect(decision.logMessage).toContain("issue closed during refinement");
		}
	});

	it("marks stale when the issue body changed during refinement", () => {
		const decision = evaluateProposalApplicability({
			...baseInput,
			currentIssue: { state: "open", title: "Test", body: "Modified body" },
		});
		expect(decision.outcome).toBe("stale");
		if (decision.outcome === "stale") {
			expect(decision.reason).toBe("issue body changed during refinement");
			expect(decision.comment).toContain("The issue body changed during refinement");
			expect(decision.logMessage).toContain("issue body changed during refinement");
		}
	});

	it("marks stale when the issue title changed during refinement", () => {
		const decision = evaluateProposalApplicability({
			...baseInput,
			currentIssue: { state: "open", title: "Renamed by maintainer", body: "Body" },
			proposedTitle: "Clearer Title",
		});
		expect(decision.outcome).toBe("stale");
		if (decision.outcome === "stale") {
			expect(decision.reason).toBe("issue title changed during refinement");
			expect(decision.comment).toContain("The issue title changed during refinement");
			expect(decision.logMessage).toContain("issue title changed during refinement");
		}
	});

	it("fails oversized proposed bodies before publication", () => {
		const decision = evaluateProposalApplicability({
			...baseInput,
			proposedTaskBody: "x".repeat(65536),
		});
		expect(decision.outcome).toBe("failed");
		if (decision.outcome === "failed") {
			expect(decision.reason).toBe("proposed task body exceeds GitHub size limit");
			expect(decision.comment).toContain("too large for GitHub");
			expect(decision.logMessage).toContain("proposed task body exceeds GitHub size limit");
		}
	});

	it("fails oversized proposed titles before publication", () => {
		const decision = evaluateProposalApplicability({
			...baseInput,
			proposedTitle: "x".repeat(257),
		});
		expect(decision.outcome).toBe("failed");
		if (decision.outcome === "failed") {
			expect(decision.reason).toBe("proposed title exceeds GitHub size limit");
			expect(decision.comment).toContain("too long for GitHub");
			expect(decision.logMessage).toContain("proposed title exceeds GitHub size limit");
		}
	});

	it("checks staleness before GitHub size limits", () => {
		const decision = evaluateProposalApplicability({
			...baseInput,
			currentIssue: { state: "closed", title: "Test", body: "Body" },
			proposedTaskBody: "x".repeat(65536),
		});
		expect(decision.outcome).toBe("stale");
	});

	it("marks stale when the issue is missing during refinement", () => {
		const decision = evaluateProposalApplicability({
			...baseInput,
			currentIssue: null,
		});
		expect(decision.outcome).toBe("stale");
		expect(decision.outcome === "stale" && decision.reason).toBe("issue closed during refinement");
	});

	it("does not apply a title exceeding the limit even when the body is valid", () => {
		const decision = evaluateProposalApplicability({
			...baseInput,
			proposedTitle: "x".repeat(257),
		});
		expect(decision.outcome).not.toBe("apply");
	});
});