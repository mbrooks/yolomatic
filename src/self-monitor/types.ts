export type FatalErrorCategory =
	| "missing_binary_after_install"
	| "permission_denied"
	| "disk_full"
	| "git_worktree_failure"
	| "missing_toolchain_binary"
	| "github_pat_scope_missing";

export interface ToolCallRecord {
	toolName: string;
	args: unknown;
	result: unknown;
	isError: boolean;
	timestamp: string;
}

export interface FatalErrorDetails {
	category: FatalErrorCategory;
	message: string;
	toolName: string;
}

export interface SystemEvidence {
	whoami: string;
	pwd: string;
	workspacePath: string;
	lsWorkspace: string;
	gitStatus: string;
	gitDiff: string;
	gitBranch: string;
	nodeVersion: string;
	timestamp: string;
}

export interface Evidence {
	toolHistory: ToolCallRecord[];
	fatalError: FatalErrorDetails;
	systemEvidence: SystemEvidence;
}
