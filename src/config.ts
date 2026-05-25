import path from "node:path";
import type { SettingsStore } from "./settings/store.js";

export interface AppConfig {
	port: number;
	autoStart: boolean;
	webhookSecret: string;
	sessionsDir: string;
	archiveDir: string;
	defaultBranch: string;
	githubToken: string;
	githubUsername: string;
	workspacesDir: string;
	soulPath: string;
	selfReportEnabled: boolean;
	maxIterations: number;
	adminUsername: string | undefined;
	adminPassword: string | undefined;
	adminGithubUsername: string | undefined;
	memoryDir: string;
	cleanupRetentionDays: number | undefined;
	staleThresholdMs: number;
	maxWorktrees: number;
	evictionStrategy: "fifo" | "lru";
	piAgentModel: string | undefined;
	piAgentProvider: string | undefined;
	logLevel: string;
	logPrompts: boolean;
	logThoughts: boolean;
	logTools: boolean;
	logResponses: boolean;
}

export function getConfig(store: SettingsStore): AppConfig {
	const sessionsDir = path.resolve(store.getString("sessions_dir", "./sessions"));
	const rawArchiveDir = store.get("archive_dir");
	const archiveDir = rawArchiveDir ? path.resolve(rawArchiveDir) : path.join(sessionsDir, "archive");
	const rawCleanup = store.get("cleanup_retention_days");

	return {
		port: store.getNumber("port", 3000),
		autoStart: store.getBoolean("auto_start", false),
		webhookSecret: store.getString("webhook_secret"),
		sessionsDir,
		archiveDir,
		memoryDir: path.resolve(store.getString("memory_dir", "./memory")),
		defaultBranch: store.getString("default_branch", "main"),
		githubToken: store.getString("github_token"),
		githubUsername: store.getString("github_username"),
		workspacesDir: path.resolve(store.getString("workspaces_dir", "./workspaces")),
		soulPath: path.resolve(store.getString("soul_path", "./SOUL.md")),
		selfReportEnabled: store.getBoolean("self_report_enabled", true),
		maxIterations: store.getNumber("max_iterations", 3),
		adminUsername: store.get("admin_username"),
		adminPassword: store.get("admin_password"),
		adminGithubUsername: store.get("admin_github_username") ?? store.get("admin_username") ?? undefined,
		cleanupRetentionDays: (() => {
			if (!rawCleanup) return undefined;
			const parsed = Number.parseInt(rawCleanup, 10);
			return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
		})(),
		staleThresholdMs: store.getNumber("stale_threshold_ms", 14400000),
		maxWorktrees: Math.max(1, store.getNumber("max_worktrees", 10)),
		evictionStrategy: store.getString("eviction_strategy", "lru").toLowerCase() === "fifo" ? "fifo" : "lru",
		piAgentModel: store.get("pi_agent_model"),
		piAgentProvider: store.get("pi_agent_provider"),
		logLevel: store.getString("log_level", "info").toLowerCase(),
		logPrompts: store.getBoolean("log_prompts", true),
		logThoughts: store.getBoolean("log_thoughts", true),
		logTools: store.getBoolean("log_tools", true),
		logResponses: store.getBoolean("log_responses", true),
	};
}
