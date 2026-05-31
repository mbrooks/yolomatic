import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { WorkspaceManager } from "../../workspace/manager.js";

export class WorkspaceServiceAdapter implements WorkspaceService {
	constructor(private readonly manager: WorkspaceManager) {}

	createOrGetWorktree(owner: string, repo: string, issueNumber: number): Promise<{ path: string; branch: string }> {
		return this.manager.createOrGetWorktree(owner, repo, issueNumber);
	}

	removeWorktree(owner: string, repo: string, issueNumber: number): Promise<void> {
		return this.manager.removeWorktree(owner, repo, issueNumber);
	}

	commitAndPush(owner: string, repo: string, issueNumber: number, message?: string): Promise<boolean> {
		return this.manager.commitAndPush(owner, repo, issueNumber, message);
	}

	hasChanges(workspacePath: string, cached?: boolean): Promise<boolean> {
		return this.manager.hasChanges(workspacePath, cached);
	}

	getWorktreePath(owner: string, repo: string, issueNumber: number): string {
		return this.manager.getWorktreePath(owner, repo, issueNumber);
	}

	getGitStatus(owner: string, repo: string, issueNumber: number): Promise<string> {
		return this.manager.getGitStatus(owner, repo, issueNumber);
	}

	getGitDiff(owner: string, repo: string, issueNumber: number): Promise<string> {
		return this.manager.getGitDiff(owner, repo, issueNumber);
	}
}
