export interface WorkspaceService {
	createOrGetWorktree(owner: string, repo: string, issueNumber: number): Promise<{ path: string; branch: string }>;
	syncWorktree(owner: string, repo: string, issueNumber: number): Promise<void>;
	removeWorktree(owner: string, repo: string, issueNumber: number): Promise<void>;
	createRefinementWorktree?(owner: string, repo: string, issueNumber: number): Promise<string>;
	removeRefinementWorktree?(worktreePath: string): Promise<void>;
	commitAndPush(owner: string, repo: string, issueNumber: number, message?: string): Promise<boolean>;
	commitAndPushPath(worktreePath: string, branchName: string, message?: string, baseBranch?: string): Promise<boolean>;
	hasChanges(workspacePath: string, cached?: boolean): Promise<boolean>;
	getWorktreePath(owner: string, repo: string, issueNumber: number): string;
	getGitStatus(owner: string, repo: string, issueNumber: number): Promise<string>;
	getGitDiff(owner: string, repo: string, issueNumber: number): Promise<string>;
}
