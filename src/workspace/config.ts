import path from "node:path";

export interface WorkspaceConfig {
	workspacesDir: string;
	githubUsername: string;
	githubToken: string;
	defaultBranch: string;
	maxWorktrees?: number;
	evictionStrategy?: "fifo" | "lru";
}

const DEFAULT_BRANCH = "main";
const DEFAULT_WORKSPACES_DIR = path.resolve(process.cwd(), "workspaces");

function requireEnv(name: "GITHUB_USERNAME" | "GITHUB_TOKEN"): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`${name} environment variable is required`);
	}
	return value;
}

export function getWorkspaceConfig(): WorkspaceConfig {
	return {
		workspacesDir: path.resolve(process.env.WORKSPACES_DIR?.trim() || DEFAULT_WORKSPACES_DIR),
		githubUsername: requireEnv("GITHUB_USERNAME"),
		githubToken: requireEnv("GITHUB_TOKEN"),
		defaultBranch: process.env.DEFAULT_BRANCH?.trim() || DEFAULT_BRANCH,
		maxWorktrees: Math.max(1, Number.parseInt(process.env.MAX_WORKTREES ?? "10", 10)),
		evictionStrategy: process.env.WORKTREE_EVICTION_STRATEGY?.trim().toLowerCase() === "fifo" ? "fifo" : "lru",
	};
}
