export interface WorkspaceService {
	createOrGetWorktree(owner: string, repo: string, issueNumber: number): Promise<{ path: string; branch: string }>;
	removeWorktree(owner: string, repo: string, issueNumber: number): Promise<void>;
	commitAndPush(owner: string, repo: string, issueNumber: number, message?: string): Promise<boolean>;
	hasChanges(workspacePath: string, cached?: boolean): Promise<boolean>;
	getWorktreePath(owner: string, repo: string, issueNumber: number): string;
}
