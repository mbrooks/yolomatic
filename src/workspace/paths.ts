import path from "node:path";

export function normalizeSegment(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error(`${label} is required`);
	}
	if (!/^[a-zA-Z0-9._-]+$/u.test(trimmed)) {
		throw new Error(`Invalid ${label}: ${value}`);
	}
	return trimmed;
}

export function getRepoKey(owner: string, repo: string): string {
	return `${normalizeSegment(owner, "owner")}-${normalizeSegment(repo, "repo")}`.toLowerCase();
}

export function getBareRepoPath(workspacesDir: string, owner: string, repo: string): string {
	return path.join(workspacesDir, getRepoKey(owner, repo));
}

export function getWorktreePath(
	workspacesDir: string,
	owner: string,
	repo: string,
	issueNumber: number,
): string {
	return path.join(getBareRepoPath(workspacesDir, owner, repo), ".worktrees", `issue-${issueNumber}`);
}

export function getBranchName(issueNumber: number): string {
	return `tars/issue-${issueNumber}`;
}
