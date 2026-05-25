import path from "node:path";
import type { SettingsStore } from "../settings/store.js";

export interface WorkspaceConfig {
	workspacesDir: string;
	githubUsername: string;
	githubToken: string;
	defaultBranch: string;
	maxWorktrees?: number;
	evictionStrategy?: "fifo" | "lru";
}

export function getWorkspaceConfig(store: SettingsStore): WorkspaceConfig {
	return {
		workspacesDir: path.resolve(store.getString("workspaces_dir", "./workspaces")),
		githubUsername: store.getString("github_username"),
		githubToken: store.getString("github_token"),
		defaultBranch: store.getString("default_branch", "main"),
		maxWorktrees: Math.max(1, store.getNumber("max_worktrees", 10)),
		evictionStrategy: store.getString("eviction_strategy", "lru").toLowerCase() === "fifo" ? "fifo" : "lru",
	};
}
