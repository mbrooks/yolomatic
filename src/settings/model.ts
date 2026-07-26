export type SettingType = "string" | "number" | "boolean";

/**
 * Indicates where the effective value of a setting comes from.
 *
 * - `env`: the value is supplied by an environment variable (`.env`), and
 *   cannot be changed through the admin UI.
 * - `database`: the value is read from the SQLite settings store and may be
 *   edited through the admin UI.
 */
export type EnvSource = "env" | "database";

export interface SettingDefinition {
	key: string;
	type: SettingType;
	description: string;
	default?: string;
	requiresRestart: boolean;
	sensitive: boolean;
	envVar: string;
	category: string;
}

export interface SettingEntry {
	key: string;
	value: string;
	updatedAt: string;
}

export interface SettingView {
	key: string;
	value: string | number | boolean;
	type: SettingType;
	description: string;
	default?: string | number | boolean;
	requiresRestart: boolean;
	sensitive: boolean;
	updatedAt: string;
	category: string;
	envSource: EnvSource;
}

export const SETTING_DEFINITIONS: SettingDefinition[] = [
	{
		key: "webhook_secret",
		type: "string",
		description: "GitHub webhook HMAC secret",
		requiresRestart: true,
		sensitive: true,
		envVar: "WEBHOOK_SECRET",
		category: "github-integration",
	},
	{
		key: "github_token",
		type: "string",
		description: "GitHub personal access token",
		requiresRestart: true,
		sensitive: true,
		envVar: "GITHUB_TOKEN",
		category: "github-integration",
	},
	{
		key: "github_username",
		type: "string",
		description: "GitHub username for this TARS instance",
		requiresRestart: true,
		sensitive: false,
		envVar: "GITHUB_USERNAME",
		category: "github-integration",
	},
	{
		key: "github_event_mode",
		type: "string",
		description: "GitHub event ingestion mode: webhook, polling, or both",
		default: "webhook",
		requiresRestart: true,
		sensitive: false,
		envVar: "GITHUB_EVENT_MODE",
		category: "github-integration",
	},
	{
		key: "github_poll_interval_ms",
		type: "number",
		description: "GitHub polling interval in milliseconds",
		default: "60000",
		requiresRestart: true,
		sensitive: false,
		envVar: "GITHUB_POLL_INTERVAL_MS",
		category: "github-integration",
	},
	{
		key: "admin_username",
		type: "string",
		description: "Admin UI username (Basic Auth)",
		requiresRestart: true,
		sensitive: false,
		envVar: "ADMIN_USERNAME",
		category: "authentication",
	},
	{
		key: "admin_password",
		type: "string",
		description: "Admin UI password (Basic Auth)",
		requiresRestart: true,
		sensitive: true,
		envVar: "ADMIN_PASSWORD",
		category: "authentication",
	},
	{
		key: "admin_github_username",
		type: "string",
		description: "GitHub user authorized for /tars stop (defaults to admin_username)",
		requiresRestart: true,
		sensitive: false,
		envVar: "ADMIN_GITHUB_USERNAME",
		category: "authentication",
	},
	{
		key: "port",
		type: "number",
		description: "HTTP server port",
		default: "6767",
		requiresRestart: true,
		sensitive: false,
		envVar: "PORT",
		category: "server",
	},
	{
		key: "configured_repositories",
		type: "string",
		description: "JSON list of repositories configured during onboarding",
		default: "[]",
		requiresRestart: false,
		sensitive: false,
		envVar: "CONFIGURED_REPOSITORIES",
		category: "repositories",
	},
	{
		key: "onboarding_complete",
		type: "boolean",
		description: "Whether the onboarding wizard has been completed",
		requiresRestart: true,
		sensitive: false,
		envVar: "ONBOARDING_COMPLETE",
		category: "server",
	},
	{
		key: "sessions_dir",
		type: "string",
		description: "Directory for session state files",
		default: "./sessions",
		requiresRestart: true,
		sensitive: false,
		envVar: "SESSIONS_DIR",
		category: "file-system",
	},
	{
		key: "workspaces_dir",
		type: "string",
		description: "Directory for git worktrees",
		default: "./workspaces",
		requiresRestart: true,
		sensitive: false,
		envVar: "WORKSPACES_DIR",
		category: "file-system",
	},
	{
		key: "archive_dir",
		type: "string",
		description: "Directory to archive stale sessions",
		requiresRestart: true,
		sensitive: false,
		envVar: "ARCHIVE_DIR",
		category: "file-system",
	},
	{
		key: "memory_dir",
		type: "string",
		description: "Directory for SQLite databases (settings)",
		default: "./memory",
		requiresRestart: true,
		sensitive: false,
		envVar: "MEMORY_DIR",
		category: "file-system",
	},
	{
		key: "soul_path",
		type: "string",
		description: "Path to SOUL.md personality definition",
		default: "./SOUL.md",
		requiresRestart: true,
		sensitive: false,
		envVar: "SOUL_PATH",
		category: "file-system",
	},
	{
		key: "worker_workspace_mount_source",
		type: "string",
		description: "Docker bind path or volume name exposed to workers as /workspaces",
		requiresRestart: true,
		sensitive: false,
		envVar: "TARS_WORKER_WORKSPACE_MOUNT_SOURCE",
		category: "file-system",
	},
	{
		key: "worker_control_base_url",
		type: "string",
		description: "Base HTTP URL workers use to open their WebSocket control-plane connection",
		requiresRestart: true,
		sensitive: false,
		envVar: "TARS_WORKER_CONTROL_BASE_URL",
		category: "file-system",
	},
	{
		key: "worker_docker_network_mode",
		type: "string",
		description: "Optional docker run --network mode for worker containers (for example container:tars)",
		requiresRestart: true,
		sensitive: false,
		envVar: "TARS_WORKER_DOCKER_NETWORK_MODE",
		category: "file-system",
	},
	{
		key: "default_branch",
		type: "string",
		description: "Default git branch for new worktrees",
		default: "main",
		requiresRestart: true,
		sensitive: false,
		envVar: "DEFAULT_BRANCH",
		category: "git-worktrees",
	},
	{
		key: "max_worktrees",
		type: "number",
		description: "Max worktrees per repo before eviction",
		default: "10",
		requiresRestart: false,
		sensitive: false,
		envVar: "MAX_WORKTREES",
		category: "git-worktrees",
	},
	{
		key: "eviction_strategy",
		type: "string",
		description: "Worktree eviction strategy: fifo or lru",
		default: "lru",
		requiresRestart: false,
		sensitive: false,
		envVar: "WORKTREE_EVICTION_STRATEGY",
		category: "git-worktrees",
	},
	{
		key: "self_report_enabled",
		type: "boolean",
		description: "Enable self-monitoring reports in session logs",
		default: "true",
		requiresRestart: false,
		sensitive: false,
		envVar: "TARS_SELF_REPORT_ENABLED",
		category: "agent-behavior",
	},
	{
		key: "worker_image",
		type: "string",
		description: "Docker image tag used for disposable worker containers",
		default: "tars-worker:latest",
		requiresRestart: true,
		sensitive: false,
		envVar: "TARS_WORKER_IMAGE",
		category: "agent-behavior",
	},
	{
		key: "worker_ollama_host",
		type: "string",
		description: "Optional OLLAMA_HOST override passed into worker containers",
		requiresRestart: true,
		sensitive: false,
		envVar: "TARS_WORKER_OLLAMA_HOST",
		category: "agent-behavior",
	},
	{
		key: "cleanup_retention_days",
		type: "number",
		description: "Days to retain sessions before cleanup (0 or empty to disable)",
		requiresRestart: true,
		sensitive: false,
		envVar: "CLEANUP_RETENTION_DAYS",
		category: "agent-behavior",
	},
	{
		key: "stale_threshold_ms",
		type: "number",
		description: "Age (ms) before a working session is considered stale",
		default: "14400000",
		requiresRestart: false,
		sensitive: false,
		envVar: "STALE_THRESHOLD_MS",
		category: "agent-behavior",
	},
	{
		key: "pi_agent_model",
		type: "string",
		description: "LLM model identifier (e.g. kimi-k2.7-code:cloud)",
		requiresRestart: false,
		sensitive: false,
		envVar: "PI_AGENT_MODEL",
		category: "ai-llm",
	},
	{
		key: "pi_agent_provider",
		type: "string",
		description: "LLM provider (e.g. ollama)",
		requiresRestart: false,
		sensitive: false,
		envVar: "PI_AGENT_PROVIDER",
		category: "ai-llm",
	},
	{
		key: "log_level",
		type: "string",
		description: "Log verbosity: error, warn, info, debug",
		default: "info",
		requiresRestart: false,
		sensitive: false,
		envVar: "LOG_LEVEL",
		category: "logging",
	},
	{
		key: "log_prompts",
		type: "boolean",
		description: "Log LLM prompts",
		default: "true",
		requiresRestart: false,
		sensitive: false,
		envVar: "LOG_PROMPTS",
		category: "logging",
	},
	{
		key: "log_thoughts",
		type: "boolean",
		description: "Log LLM chain-of-thought",
		default: "true",
		requiresRestart: false,
		sensitive: false,
		envVar: "LOG_THOUGHTS",
		category: "logging",
	},
	{
		key: "log_tools",
		type: "boolean",
		description: "Log tool calls and results",
		default: "true",
		requiresRestart: false,
		sensitive: false,
		envVar: "LOG_TOOLS",
		category: "logging",
	},
	{
		key: "log_responses",
		type: "boolean",
		description: "Log LLM responses",
		default: "true",
		requiresRestart: false,
		sensitive: false,
		envVar: "LOG_RESPONSES",
		category: "logging",
	},
];

const DEFINITION_MAP = new Map(SETTING_DEFINITIONS.map((d) => [d.key, d]));

export function getSettingDefinition(key: string): SettingDefinition | undefined {
	return DEFINITION_MAP.get(key);
}

export function parseSettingValue(def: SettingDefinition, raw: string): string | number | boolean {
	if (def.type === "number") {
		const parsed = Number.parseInt(raw, 10);
		return Number.isNaN(parsed) ? 0 : parsed;
	}
	if (def.type === "boolean") {
		return raw === "true";
	}
	return raw;
}

export function formatSettingValue(def: SettingDefinition, value: string | number | boolean): string {
	if (def.type === "boolean") {
		return value === true ? "true" : "false";
	}
	return String(value);
}

export function coerceEnvValue(key: string, envValue: string): string | undefined {
	const def = getSettingDefinition(key);
	if (!def) return envValue;
	const trimmed = envValue.trim();
	if (!trimmed) return undefined;
	if (def.type === "number") {
		const parsed = Number.parseInt(trimmed, 10);
		if (Number.isNaN(parsed) || parsed < 0) return undefined;
		return String(parsed);
	}
	if (def.type === "boolean") {
		return trimmed === "true" ? "true" : "false";
	}
	return trimmed;
}
