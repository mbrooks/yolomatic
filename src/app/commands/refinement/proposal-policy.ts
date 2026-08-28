import { fingerprintBody } from "../../../refinement/fingerprint.js";

/**
 * Shape of the issue as it is at publication time. `null` means the issue
 * could not be re-fetched; the proposal is then treated as stale.
 */
export type ProposalCurrentIssue = {
	state?: string;
	title?: string;
	body?: string | null;
} | null;

export interface ProposalApplicabilityInput {
	currentIssue: ProposalCurrentIssue;
	originalTitle: string;
	/** SHA-256 fingerprint of the issue body captured when refinement started. */
	originalBodyFingerprint: string;
	proposedTaskBody: string;
	proposedTitle?: string;
}

export type ProposalApplicabilityDecision =
	| {
			outcome: "stale";
			reason: "issue closed during refinement" | "issue body changed during refinement" | "issue title changed during refinement";
			comment: string;
			logMessage: string;
	  }
	| {
			outcome: "failed";
			reason: "proposed task body exceeds GitHub size limit" | "proposed title exceeds GitHub size limit";
			comment: string;
			logMessage: string;
	  }
	| {
			outcome: "apply";
			applyTitle: boolean;
			proposedTitle: string;
	  };

/** GitHub issue body size limit (chars). */
export const GITHUB_BODY_LIMIT = 65535;
/** GitHub issue title size limit (chars). */
export const GITHUB_TITLE_LIMIT = 256;

/**
 * Purely decide whether a worker proposal can be published. The checks run in
 * the historical order: closed issue, body change, title change, body size,
 * title size. Each non-apply outcome carries the exact comment text, stored
 * reason, and warn-log message the façade must emit. The façade performs the
 * persistence and GitHub update calls based on this decision.
 */
export function evaluateProposalApplicability(
	input: ProposalApplicabilityInput,
): ProposalApplicabilityDecision {
	if (!input.currentIssue || input.currentIssue.state === "closed") {
		return {
			outcome: "stale",
			reason: "issue closed during refinement",
			comment: "The issue changed during refinement. Please run `/yolomatic issue-refinement` again.",
			logMessage: "Refinement marked stale: issue closed during refinement",
		};
	}

	const currentFingerprint = fingerprintBody(input.currentIssue.body ?? "");
	if (currentFingerprint !== input.originalBodyFingerprint) {
		return {
			outcome: "stale",
			reason: "issue body changed during refinement",
			comment: "The issue body changed during refinement. Please run `/yolomatic issue-refinement` again.",
			logMessage: "Refinement marked stale: issue body changed during refinement",
		};
	}

	if (input.currentIssue.title !== undefined && input.currentIssue.title !== input.originalTitle) {
		return {
			outcome: "stale",
			reason: "issue title changed during refinement",
			comment: "The issue title changed during refinement. Please run `/yolomatic issue-refinement` again.",
			logMessage: "Refinement marked stale: issue title changed during refinement",
		};
	}

	if (input.proposedTaskBody.length > GITHUB_BODY_LIMIT) {
		return {
			outcome: "failed",
			reason: "proposed task body exceeds GitHub size limit",
			comment: "Refinement produced a body that is too large for GitHub. Please run the command again with a narrower request.",
			logMessage: "Refinement failed: proposed task body exceeds GitHub size limit",
		};
	}

	const proposedTitle = input.proposedTitle?.trim() ?? "";
	const applyTitle = proposedTitle.length > 0 && proposedTitle !== input.originalTitle;
	if (applyTitle && proposedTitle.length > GITHUB_TITLE_LIMIT) {
		return {
			outcome: "failed",
			reason: "proposed title exceeds GitHub size limit",
			comment: "Refinement produced a title that is too long for GitHub. Please run the command again with a narrower request.",
			logMessage: "Refinement failed: proposed title exceeds GitHub size limit",
		};
	}

	return { outcome: "apply", applyTitle, proposedTitle };
}