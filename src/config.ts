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
	selfReportEnabled: boolean;
	maxIterations: number;
	adminUsername: string | undefined;
	adminPassword: string | undefined;
	adminGithubUsername: string | undefined;
	cleanupRetentionDays: number | undefined;
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
		selfReportEnabled: process.env.TARS_SELF_REPORT_ENABLED !== "false",
		maxIterations: Number.parseInt(process.env.MAX_ITERATIONS ?? "3", 10),
		adminUsername: process.env.ADMIN_USERNAME?.trim() || undefined,
		adminPassword: process.env.ADMIN_PASSWORD?.trim() || undefined,
		adminGithubUsername: process.env.ADMIN_GITHUB_USERNAME?.trim() || process.env.ADMIN_USERNAME?.trim() || undefined,
		cleanupRetentionDays: (() => {
			const raw = process.env.CLEANUP_RETENTION_DAYS?.trim();
			if (!raw) return undefined;
			const parsed = Number.parseInt(raw, 10);
			return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
		})(),
	};
}
