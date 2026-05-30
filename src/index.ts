import "dotenv/config";

import path from "node:path";
import { getConfig, isBootstrapComplete } from "./config.js";
import { SettingsStore } from "./settings/store.js";
import { PiAgentExecutor } from "./executor/index.js";
import { CronStore } from "./cron/store.js";
import { startCronScheduler } from "./cron/scheduler.js";
import { SessionManager } from "./session/manager.js";
import { SessionStore } from "./session/store.js";
import { StaleSessionDetector } from "./session/stale-detector.js";
import { TaskController } from "./task-controller.js";
import { GitHubIssueHandlers, type WebhookHandlers } from "./webhook/handlers.js";
import { cleanupOldSessions, createWebhookServer } from "./webhook/server.js";
import { createWebhookServerDeps } from "./webhook/server-deps.js";
import { SkillStore } from "./skills/store.js";
import { RepoSkillService } from "./skills/repo-skill-service.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { GitHubServiceAdapter } from "./adapters/github/github-service-adapter.js";

const noOpHandlers: WebhookHandlers = {
	async handleIssueEvent() {},
	async handleCommentEvent() {},
	async handlePullRequestReviewCommentEvent() {},
	async handlePullRequestReviewEvent() {},
	isInFlight() { return false; },
};

export async function main(): Promise<void> {
	const memoryDir = path.resolve(process.env.MEMORY_DIR?.trim() || path.join(process.cwd(), "memory"));
	const settingsStore = new SettingsStore(path.join(memoryDir, "bot-state.sqlite"));
	settingsStore.seedFromEnv();
	settingsStore.applyDefaults();

	const config = getConfig(settingsStore);

	const sessionStore = new SessionStore(config.sessionsDir);
	const taskController = new TaskController();

	if (!isBootstrapComplete(config)) {
		process.stdout.write("[onboarding] Required settings missing. Starting in onboarding mode.\n");

		const serverDeps = createWebhookServerDeps(
			sessionStore,
			undefined,
			undefined,
			taskController,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			settingsStore,
		);

		const server = createWebhookServer(
			config.webhookSecret || "dummy-onboarding-secret",
			noOpHandlers,
			sessionStore,
			undefined,
			undefined,
			taskController,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			settingsStore,
		);

		serverDeps.adminUsername = config.adminUsername;
		serverDeps.adminPassword = config.adminPassword;

		server.listen(config.port, () => {
			process.stdout.write(`[onboarding] Server listening on port ${config.port}\n`);
		});
		return;
	}

	// Sync database settings to process.env so legacy code paths pick them up
	process.env.PI_AGENT_MODEL = config.piAgentModel ?? "";
	process.env.PI_AGENT_PROVIDER = config.piAgentProvider ?? "";
	process.env.LOG_LEVEL = config.logLevel;
	process.env.LOG_PROMPTS = config.logPrompts ? "true" : "";
	process.env.LOG_THOUGHTS = config.logThoughts ? "true" : "";
	process.env.LOG_TOOLS = config.logTools ? "true" : "";
	process.env.LOG_RESPONSES = config.logResponses ? "true" : "";

	const sessionManager = new SessionManager(config.sessionsDir, sessionStore);
	const workspaceManager = new WorkspaceManager({
		workspacesDir: config.workspacesDir,
		githubUsername: config.githubUsername,
		githubToken: config.githubToken,
		defaultBranch: config.defaultBranch,
		maxWorktrees: config.maxWorktrees,
		evictionStrategy: config.evictionStrategy,
	});
	const executor = new PiAgentExecutor({ soulPath: config.soulPath });
	const handlers = new GitHubIssueHandlers({
		sessionManager,
		workspaceManager,
		executor,
		githubToken: config.githubToken,
		githubUsername: config.githubUsername,
		autoStart: config.autoStart,
		defaultBranch: config.defaultBranch,
		selfReportEnabled: config.selfReportEnabled,
		maxIterations: config.maxIterations,
		taskController,
		adminGithubUsername: config.adminGithubUsername,
	});

	const staleDetector = new StaleSessionDetector(
		sessionStore,
		workspaceManager,
		config.githubToken,
		(owner, repo, issueNumber) => handlers.isInFlight(owner, repo, issueNumber),
		config.staleThresholdMs,
	);

	const cronStore = new CronStore(path.join(config.memoryDir, "bot-state.sqlite"));
	const skillStore = new SkillStore(path.join(config.memoryDir, "bot-state.sqlite"));
	const repoSkillService = new RepoSkillService({
		workspacesDir: config.workspacesDir,
		githubUsername: config.githubUsername,
		githubToken: config.githubToken,
		defaultBranch: config.defaultBranch,
	});
	const github = new GitHubServiceAdapter({ githubToken: config.githubToken });
	const cronDeps = {
		cronStore,
		sessionStore,
		workspaceManager,
		executor,
		github,
		memoryDir: config.memoryDir,
		githubToken: config.githubToken,
		githubUsername: config.githubUsername,
	};
	startCronScheduler(cronDeps);

	const server = createWebhookServer(
		config.webhookSecret,
		handlers,
		sessionStore,
		config.adminUsername,
		config.adminPassword,
		taskController,
		workspaceManager,
		staleDetector,
		config.archiveDir,
		cronStore,
		undefined,
		github,
		settingsStore,
		skillStore,
		repoSkillService,
	);
	server.listen(config.port, () => {
		process.stdout.write(`Webhook receiver listening on port ${config.port}\n`);
	});

	// Startup stale detection: conservatively mark very old working sessions
	try {
		const staleInfos = await staleDetector.detectStaleSessions();
		const veryOldThreshold = config.staleThresholdMs * 2;
		for (const info of staleInfos) {
			if (info.isStale && info.ageMs > veryOldThreshold && !info.session.staleDetectedAt) {
				process.stdout.write(
					`[startup] Marking stale session ${info.session.owner}/${info.session.repo}#${info.session.issueNumber} as interrupted_or_abandoned\n`,
				);
				await sessionManager.markFailed(
					info.session.owner,
					info.session.repo,
					info.session.issueNumber,
					"interrupted_or_abandoned",
				);
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stdout.write(`[startup] stale detection error: ${message}\n`);
	}

	// Resume any sessions that were interrupted by a restart
	try {
		const sessions = await sessionStore.getAll();
		const sessionsToResume = sessions.filter(
			(s) => (s.resumeOnBoot || s.status === "working") && s.sessionType !== "cron",
		);
		if (sessionsToResume.length > 0) {
			process.stdout.write(`[startup] Found ${sessionsToResume.length} session(s) to resume after restart\n`);
			for (const session of sessionsToResume) {
				try {
					await handlers.resumeInterruptedSession(session.owner, session.repo, session.issueNumber);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(`[startup] failed to resume ${session.owner}/${session.repo}#${session.issueNumber}: ${message}\n`);
				}
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stdout.write(`[startup] resume error: ${message}\n`);
	}

	if (config.cleanupRetentionDays) {
		process.stdout.write(`[cleanup] auto-cleanup enabled: ${config.cleanupRetentionDays} days\n`);
		await cleanupOldSessions(sessionStore, workspaceManager, config.cleanupRetentionDays);
		const cleanupIntervalMs = 24 * 60 * 60 * 1000;
		setInterval(() => {
			void cleanupOldSessions(sessionStore, workspaceManager, config.cleanupRetentionDays!);
		}, cleanupIntervalMs);
	}
}

/* v8 ignore start */
if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		const message = error instanceof Error ? error.stack ?? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	});
}
/* v8 ignore stop */
