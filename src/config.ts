import path from "node:path";

export interface AppConfig {
	port: number;
	autoStart: boolean;
	webhookSecret: string;
	sessionsDir: string;
	defaultBranch: string;
	githubToken: string;
	githubUsername: string;
	workspacesDir: string;
	soulPath: string;
	sessionTimeoutMinutes: number;
}

function parseTimeoutMinutes(value: unknown): number {
	if (value === undefined || value === null || value === "") {
		return 30;
	}
	const num = Number(value);
	if (!Number.isFinite(num)) {
		process.stderr.write(`[config] Invalid TARS_SESSION_TIMEOUT_MINUTES value "${value}", using default 30.\n`);
		return 30;
	}
	if (num < 5) {
		process.stderr.write(`[config] TARS_SESSION_TIMEOUT_MINUTES ${num} is below minimum 5, clamped to 5.\n`);
		return 5;
	}
	if (num > 60) {
		process.stderr.write(`[config] TARS_SESSION_TIMEOUT_MINUTES ${num} exceeds maximum 60, clamped to 60.\n`);
		return 60;
	}
	return num;
}

function requireEnv(name: keyof NodeJS.ProcessEnv): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`${name} environment variable is required`);
	}
	return value;
}

export function getConfig(): AppConfig {
	return {
		port: Number.parseInt(process.env.PORT ?? "3000", 10),
		autoStart: process.env.AUTO_START === "true",
		webhookSecret: requireEnv("WEBHOOK_SECRET"),
		sessionsDir: path.resolve(process.env.SESSIONS_DIR?.trim() || path.join(process.cwd(), "sessions")),
		defaultBranch: process.env.DEFAULT_BRANCH?.trim() || "main",
		githubToken: requireEnv("GITHUB_TOKEN"),
		githubUsername: requireEnv("GITHUB_USERNAME"),
		workspacesDir: path.resolve(process.env.WORKSPACES_DIR?.trim() || path.join(process.cwd(), "workspaces")),
		soulPath: path.resolve(process.env.SOUL_PATH?.trim() || path.join(process.cwd(), "SOUL.md")),
		sessionTimeoutMinutes: parseTimeoutMinutes(process.env.TARS_SESSION_TIMEOUT_MINUTES),
	};
}
