import path from "node:path";
import type { SettingsStore } from "./settings/store.js";

export const DEFAULT_ADMIN_PATH = "/yolomatic/admin";
export const DEFAULT_ADMIN_DEFAULT_PAGE = "#/dashboard";

/**
 * Normalize a configured admin HTTP path prefix.
 *
 * Ensures the path starts with "/" and does not end with "/" (except for
 * the root path "/" itself). Empty/blank values fall back to the default.
 */
export function normalizeAdminPath(raw: string | undefined): string {
	const value = (raw ?? "").trim() || DEFAULT_ADMIN_PATH;
	let normalized = value;
	if (!normalized.startsWith("/")) {
		normalized = `/${normalized}`;
	}
	if (normalized.length > 1) {
		normalized = normalized.replace(/\/+$/u, "");
	}
	return normalized || "/";
}

/**
 * Build the WebSocket upgrade path for the configured admin path prefix.
 */
export function adminWebSocketPath(adminPath: string): string {
	return adminPath === "/" ? "/ws" : `${adminPath}/ws`;
}

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
	workerPiAuthMountSource: string;
	workerPiAuthDir: string;
	openaiApiKey: string;
	adminPath: string;
	adminDefaultPage: string;
	issueNewCommentEnabled: boolean;
	issueAdminLinkInCommentsEnabled: boolean;
	adminBaseUrl: string | undefined;
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
		onboardingComplete: store.getBoolean("onboarding_complete"),
		adminGithubUsername: store.get("admin_github_username") ?? undefined,
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
		workerImage: store.get("worker_image") ?? "yolomatic-worker:latest",
		workerWorkspaceMountSource: store.get("worker_workspace_mount_source") ?? path.resolve(store.getString("workspaces_dir", "./workspaces")),
		workerControlBaseUrl: store.get("worker_control_base_url") ?? `http://host.docker.internal:${store.getNumber("port", 6767)}`,
		workerDockerNetworkMode: store.get("worker_docker_network_mode") ?? undefined,
		workerOllamaHost: store.get("worker_ollama_host") ?? undefined,
		workerPiAuthMountSource: store.getString("worker_pi_auth_mount_source", "yolomatic_pi"),
		workerPiAuthDir: store.getString("worker_pi_auth_dir", "/home/yolomatic/.pi/agent"),
		openaiApiKey: store.get("openai_api_key") ?? "",
		adminPath: normalizeAdminPath(store.get("admin_path")),
		adminDefaultPage: (() => {
			const raw = store.get("admin_default_page")?.trim();
			return raw || DEFAULT_ADMIN_DEFAULT_PAGE;
		})(),
		issueNewCommentEnabled: store.getBoolean("issue_new_comment_enabled", true),
		issueAdminLinkInCommentsEnabled: store.getBoolean("issue_admin_link_in_comments_enabled", true),
		adminBaseUrl: (() => {
			const raw = store.get("admin_base_url")?.trim();
			return raw || undefined;
		})(),
	};
}

export function isBootstrapComplete(config: AppConfig): boolean {
	return (
		(config.githubEventMode === "polling" || config.webhookSecret !== "") &&
		config.githubToken !== "" &&
		config.githubUsername !== "" &&
		config.onboardingComplete
	);
}

export function getBootstrapMissingFields(config: AppConfig): string[] {
	const missing: string[] = [];
	if (config.githubEventMode !== "polling" && !config.webhookSecret) missing.push("webhook_secret");
	if (!config.githubToken) missing.push("github_token");
	if (!config.githubUsername) missing.push("github_username");
	if (!config.onboardingComplete) missing.push("onboarding_complete");
	return missing;
}
