export class EmptyRepositoryError extends Error {
	public readonly bareRepoPath: string;

	constructor(bareRepoPath: string) {
		super(
			`[workspace] ERROR: Cannot resolve base branch in ${bareRepoPath}\n\n` +
				`The repository appears to be empty (no commits or branches). ` +
				`Initialize it via the GitHub API before Yolomatic can create a worktree.`,
		);
		this.name = "EmptyRepositoryError";
		this.bareRepoPath = bareRepoPath;
	}
}

/**
 * Raised by syncWorktree() when the issue branch has diverged from its remote
 * tip and cannot be fast-forwarded. The control plane should resolve the
 * divergence (e.g. via the GitHub update-branch API) before launching a worker.
 */
export class WorktreeBranchDivergedError extends Error {
	public readonly branch: string;
	public readonly remoteRef: string;

	constructor(branch: string, remoteRef: string) {
		super(
			`[workspace] Branch '${branch}' has diverged from '${remoteRef}' and cannot be fast-forwarded. ` +
				`Resolve the conflict via the GitHub update-branch API before launching a worker.`,
		);
		this.name = "WorktreeBranchDivergedError";
		this.branch = branch;
		this.remoteRef = remoteRef;
	}
}
