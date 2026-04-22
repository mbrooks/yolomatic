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
	};
}
