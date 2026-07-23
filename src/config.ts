import path from "node:path";
import type { SettingsStore } from "./settings/store.js";

export interface AppConfig {
	port: number;
	webhookSecret: string;
	sessionsDir: string;
	archiveDir: string;
	defaultBranch: string;
	githubToken: string;
	githubUsername: string;
	workspacesDir: string;
	soulPath: string;
	selfReportEnabled: boolean;
	adminUsername: string | undefined;
	adminPassword: string | undefined;
	onboardingComplete: boolean;
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
	githubEventMode: "webhook" | "polling" | "both";
	githubPollIntervalMs: number;
	workerImage: string;
	workerWorkspaceMountSource: string;
	workerControlBaseUrl: string;
	workerDockerNetworkMode?: string;
	workerOllamaHost?: string;
}

export function getConfig(store: SettingsStore): AppConfig {
	const sessionsDir = path.resolve(store.getString("sessions_dir", "./sessions"));
	const rawArchiveDir = store.get("archive_dir");
	const archiveDir = rawArchiveDir ? path.resolve(rawArchiveDir) : path.join(sessionsDir, "archive");
	const rawCleanup = store.get("cleanup_retention_days");

	const rawEventMode = store.getString("github_event_mode", "webhook").toLowerCase();
	const githubEventMode = rawEventMode === "polling" || rawEventMode === "both" ? rawEventMode : "webhook";

	return {
		port: store.getNumber("port", 6767),
		webhookSecret: store.get("webhook_secret") ?? "",
		sessionsDir,
		archiveDir,
		memoryDir: path.resolve(store.getString("memory_dir", "./memory")),
		defaultBranch: store.getString("default_branch", "main"),
		githubToken: store.get("github_token") ?? "",
		githubUsername: store.get("github_username") ?? "",
		workspacesDir: path.resolve(store.getString("workspaces_dir", "./workspaces")),
		soulPath: path.resolve(store.getString("soul_path", "./SOUL.md")),
		selfReportEnabled: store.getBoolean("self_report_enabled", true),
		adminUsername: store.get("admin_username"),
		adminPassword: store.get("admin_password"),
		onboardingComplete: store.getBoolean("onboarding_complete"),
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
		githubEventMode,
		githubPollIntervalMs: Math.max(1000, store.getNumber("github_poll_interval_ms", 60000)),
		workerImage: store.get("worker_image") ?? "tars-worker:latest",
		workerWorkspaceMountSource: store.get("worker_workspace_mount_source") ?? path.resolve(store.getString("workspaces_dir", "./workspaces")),
		workerControlBaseUrl: store.get("worker_control_base_url") ?? `http://host.docker.internal:${store.getNumber("port", 6767)}`,
		workerDockerNetworkMode: store.get("worker_docker_network_mode") ?? undefined,
		workerOllamaHost: store.get("worker_ollama_host") ?? undefined,
	};
}

export function isBootstrapComplete(config: AppConfig): boolean {
	return (
		config.webhookSecret !== "" &&
		config.githubToken !== "" &&
		config.githubUsername !== "" &&
		!!config.adminUsername &&
		!!config.adminPassword &&
		config.onboardingComplete
	);
}

export function getBootstrapMissingFields(config: AppConfig): string[] {
	const missing: string[] = [];
	if (!config.webhookSecret) missing.push("webhook_secret");
	if (!config.githubToken) missing.push("github_token");
	if (!config.githubUsername) missing.push("github_username");
	if (!config.adminUsername) missing.push("admin_username");
	if (!config.adminPassword) missing.push("admin_password");
	if (!config.onboardingComplete) missing.push("onboarding_complete");
	return missing;
}
