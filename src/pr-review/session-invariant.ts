import type { SessionState } from "../session/store.js";

const YEETOMATIC_BRANCH_RE = /^yeetomatic\/issue-(\d+)$/u;

export function expectedBranchForIssue(issueNumber: number): string {
	return `yeetomatic/issue-${issueNumber}`;
}

export function extractIssueNumberFromBranch(branch: string): number | null {
	const match = YEETOMATIC_BRANCH_RE.exec(branch);
	return match ? Number.parseInt(match[1], 10) : null;
}

export function validatePRSessionMapping(
	session: SessionState,
	prNumber: number,
	headRef: string,
): string | null {
	const headIssueNumber = extractIssueNumberFromBranch(headRef);
	if (!headIssueNumber) {
		if (session.prNumber === prNumber) {
			return null;
		}
		return `PR #${prNumber} head branch '${headRef}' is not a Yeetomatic issue branch and is not associated with this session.`;
	}

	if (headIssueNumber !== session.issueNumber) {
		return [
			`PR #${prNumber} maps to '${headRef}' (issue #${headIssueNumber}),`,
			`but session ${session.owner}/${session.repo}#${session.issueNumber} is for '${expectedBranchForIssue(session.issueNumber)}'.`,
		].join(" ");
	}

	if (session.prNumber !== undefined && session.prNumber !== prNumber) {
		return [
			`Session ${session.owner}/${session.repo}#${session.issueNumber} is already associated with PR #${session.prNumber},`,
			`but this event is for PR #${prNumber}.`,
		].join(" ");
	}

	return null;
}
