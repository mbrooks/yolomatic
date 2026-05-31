export class EmptyRepositoryError extends Error {
	public readonly bareRepoPath: string;

	constructor(bareRepoPath: string) {
		super(
			`[workspace] ERROR: Cannot resolve base branch in ${bareRepoPath}\n\n` +
				`The repository appears to be empty (no commits or branches). ` +
				`Initialize it via the GitHub API before TARS can create a worktree.`,
		);
		this.name = "EmptyRepositoryError";
		this.bareRepoPath = bareRepoPath;
	}
}
