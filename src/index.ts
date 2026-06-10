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
import { SkillStore } from "./skills/store.js";
import { RepoSkillService } from "./skills/repo-skill-service.js";
import { WorkspaceManager } from "./workspace/manager.js";
import { GitHubServiceAdapter } from "./adapters/github/github-service-adapter.js";

export const noOpHandlers: WebhookHandlers = {
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
	let onboardingServer: ReturnType<typeof createWebhookServer> | undefined;
	let activated = false;

	function syncConfigToEnv(nextConfig: typeof config): void {
		// Sync database settings to process.env so legacy code paths pick them up.
		process.env.PI_AGENT_MODEL = nextConfig.piAgentModel ?? "";
		process.env.PI_AGENT_PROVIDER = nextConfig.piAgentProvider ?? "";
		process.env.LOG_LEVEL = nextConfig.logLevel;
		process.env.LOG_PROMPTS = nextConfig.logPrompts ? "true" : "";
		process.env.LOG_THOUGHTS = nextConfig.logThoughts ? "true" : "";
		process.env.LOG_TOOLS = nextConfig.logTools ? "true" : "";
		process.env.LOG_RESPONSES = nextConfig.logResponses ? "true" : "";
	}

	async function startRuntime(nextConfig: typeof config): Promise<void> {
		syncConfigToEnv(nextConfig);

		const sessionManager = new SessionManager(nextConfig.sessionsDir, sessionStore);
		const workspaceManager = new WorkspaceManager({
			workspacesDir: nextConfig.workspacesDir,
			githubUsername: nextConfig.githubUsername,
			githubToken: nextConfig.githubToken,
			defaultBranch: nextConfig.defaultBranch,
			maxWorktrees: nextConfig.maxWorktrees,
			evictionStrategy: nextConfig.evictionStrategy,
		});
		const executor = new PiAgentExecutor({ soulPath: nextConfig.soulPath });
		const handlers = new GitHubIssueHandlers({
			sessionManager,
			workspaceManager,
			executor,
			githubToken: nextConfig.githubToken,
			githubUsername: nextConfig.githubUsername,
			autoStart: nextConfig.autoStart,
			defaultBranch: nextConfig.defaultBranch,
			selfReportEnabled: nextConfig.selfReportEnabled,
			taskController,
			adminGithubUsername: nextConfig.adminGithubUsername,
		});

		const staleDetector = new StaleSessionDetector(
			sessionStore,
			workspaceManager,
			nextConfig.githubToken,
			(owner, repo, issueNumber) => handlers.isInFlight(owner, repo, issueNumber),
			nextConfig.staleThresholdMs,
		);

		const cronStore = new CronStore(path.join(nextConfig.memoryDir, "bot-state.sqlite"));
		const skillStore = new SkillStore(path.join(nextConfig.memoryDir, "bot-state.sqlite"));
		const repoSkillService = new RepoSkillService({
			workspacesDir: nextConfig.workspacesDir,
			githubUsername: nextConfig.githubUsername,
			githubToken: nextConfig.githubToken,
			defaultBranch: nextConfig.defaultBranch,
		});
		const github = new GitHubServiceAdapter({ githubToken: nextConfig.githubToken });
		const cronDeps = {
			cronStore,
			sessionStore,
			workspaceManager,
			executor,
			github,
			memoryDir: nextConfig.memoryDir,
			githubToken: nextConfig.githubToken,
			githubUsername: nextConfig.githubUsername,
		};
		startCronScheduler(cronDeps);

		const server = createWebhookServer(
			nextConfig.webhookSecret,
			handlers,
			sessionStore,
			nextConfig.adminUsername,
			nextConfig.adminPassword,
			taskController,
			workspaceManager,
			staleDetector,
			nextConfig.archiveDir,
			cronStore,
			undefined,
			github,
			settingsStore,
			skillStore,
			repoSkillService,
		);
		server.listen(nextConfig.port, () => {
			process.stdout.write(`Webhook receiver listening on port ${nextConfig.port}\n`);
		});

		// Startup stale detection: conservatively mark very old working sessions.
		try {
			const staleInfos = await staleDetector.detectStaleSessions();
			const veryOldThreshold = nextConfig.staleThresholdMs * 2;
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

		// Resume any sessions that were interrupted by a restart.
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

		if (nextConfig.cleanupRetentionDays) {
			process.stdout.write(`[cleanup] auto-cleanup enabled: ${nextConfig.cleanupRetentionDays} days\n`);
			await cleanupOldSessions(sessionStore, workspaceManager, nextConfig.cleanupRetentionDays);
			const cleanupIntervalMs = 24 * 60 * 60 * 1000;
			const cleanupInterval = setInterval(() => {
				void cleanupOldSessions(sessionStore, workspaceManager, nextConfig.cleanupRetentionDays!);
			}, cleanupIntervalMs);
			cleanupInterval.unref?.();
		}
	}

	if (!isBootstrapComplete(config)) {
		process.stdout.write("[onboarding] Required settings missing. Starting in onboarding mode.\n");

		onboardingServer = createWebhookServer(
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
			{
				onOnboardingComplete: async () => {
					if (activated) return;
					const nextConfig = getConfig(settingsStore);
					if (!isBootstrapComplete(nextConfig)) return;
					activated = true;
					if (onboardingServer) {
						await new Promise<void>((resolve, reject) => {
							onboardingServer!.close((error) => {
								if (error) reject(error);
								else resolve();
							});
						});
					}
					process.stdout.write("[onboarding] Settings loaded. Starting full runtime.\n");
					await startRuntime(nextConfig);
				},
			},
			undefined,
			settingsStore,
		);

		onboardingServer.listen(config.port, () => {
			process.stdout.write(`[onboarding] Server listening on port ${config.port}\n`);
		});
		return;
	}

	await startRuntime(config);
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
