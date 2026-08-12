export type SettingType = "string" | "number" | "boolean";

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
		description: "GitHub username for this Yolomatic instance",
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
		key: "admin_github_username",
		type: "string",
		description: "GitHub user authorized for /yolomatic stop and /yolomatic issue-refinement",
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
		key: "admin_path",
		type: "string",
		description: "HTTP path prefix serving the admin UI and its WebSocket endpoint",
		default: "/yolomatic/admin",
		requiresRestart: true,
		sensitive: false,
		envVar: "ADMIN_PATH",
		category: "server",
	},
	{
		key: "admin_default_page",
		type: "string",
		description: "Initial admin SPA hash-route shown when no hash is present (e.g. #/dashboard)",
		default: "#/dashboard",
		requiresRestart: true,
		sensitive: false,
		envVar: "ADMIN_DEFAULT_PAGE",
		category: "server",
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
		envVar: "YOLO_WORKER_WORKSPACE_MOUNT_SOURCE",
		category: "file-system",
	},
	{
		key: "worker_control_base_url",
		type: "string",
		description: "Base HTTP URL workers use to open their WebSocket control-plane connection",
		requiresRestart: true,
		sensitive: false,
		envVar: "YOLO_WORKER_CONTROL_BASE_URL",
		category: "file-system",
	},
	{
		key: "worker_docker_network_mode",
		type: "string",
		description: "Optional docker run --network mode for worker containers (for example container:yolomatic)",
		requiresRestart: true,
		sensitive: false,
		envVar: "YOLO_WORKER_DOCKER_NETWORK_MODE",
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
		envVar: "YOLO_SELF_REPORT_ENABLED",
		category: "agent-behavior",
	},
	{
		key: "default_worker_template",
		type: "string",
		description: "Default installed worker image used when a project has no override",
		default: "node",
		requiresRestart: true,
		sensitive: false,
		envVar: "YOLO_DEFAULT_WORKER_TEMPLATE",
		category: "agent-behavior",
	},
	{
		key: "worker_ollama_host",
		type: "string",
		description: "Optional OLLAMA_HOST override passed into worker containers",
		requiresRestart: true,
		sensitive: false,
		envVar: "YOLO_WORKER_OLLAMA_HOST",
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
		description: "LLM provider used by worker containers. Supported providers: ollama, openai (OpenAI platform API key).",
		default: "ollama",
		requiresRestart: false,
		sensitive: false,
		envVar: "PI_AGENT_PROVIDER",
		category: "ai-llm",
	},
	{
		key: "openai_api_key",
		type: "string",
		description: "OpenAI platform API key. Required when pi_agent_provider is openai. Forwarded to worker containers as OPENAI_API_KEY.",
		requiresRestart: true,
		sensitive: true,
		envVar: "OPENAI_API_KEY",
		category: "ai-llm",
	},
	{
		key: "ollama_container_name",
		type: "string",
		description: "Name of the Ollama Docker container the control plane shells into to check Ollama sign-in status (defaults to yolomatic-ollama, matching docker-compose.yml). Falls back to the compose `ollama` service when unset and no explicit name is configured.",
		default: "yolomatic-ollama",
		requiresRestart: false,
		sensitive: false,
		envVar: "OLLAMA_CONTAINER_NAME",
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
	{
		key: "issue_new_comment_enabled",
		type: "boolean",
		description: "Post an automatic comment on newly opened issues explaining available Yolomatic commands.",
		default: "true",
		requiresRestart: false,
		sensitive: false,
		envVar: "YOLO_ISSUE_NEW_COMMENT_ENABLED",
		category: "issues",
	},
	{
		key: "issue_admin_link_in_comments_enabled",
		type: "boolean",
		description: "Include a link to the admin UI in the status comments Yolomatic posts on issues.",
		default: "true",
		requiresRestart: false,
		sensitive: false,
		envVar: "YOLO_ISSUE_ADMIN_LINK_IN_COMMENTS_ENABLED",
		category: "issues",
	},
	{
		key: "admin_base_url",
		type: "string",
		description: "Absolute public base URL of the admin UI used to build status-tracking links in issue comments (e.g. http://host:6767/yolomatic/admin).",
		default: "",
		requiresRestart: false,
		sensitive: false,
		envVar: "YOLO_ADMIN_BASE_URL",
		category: "server",
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
