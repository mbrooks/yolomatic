import path from "node:path";
import type { CronJob } from "./store.js";
import { CronStore } from "./store.js";
import { deliverCronResult } from "./delivery.js";
import { runCronExecution } from "./execution.js";
import { notifyCronRun } from "./notification.js";
import { finalizeCronSessionAndRecordRun, type CronRunStatus } from "./recording.js";
import { createSessionStateForCron } from "./session.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { PiAgentExecutor } from "../executor/index.js";
import type { GitHubService } from "../ports/github-service.js";
import type { SessionStore } from "../session/store.js";

const REMINDER_TICK_MS = 60_000; // check every minute

let cronIntervalId: NodeJS.Timeout | undefined;
let isTickRunning = false;
const cronJobQueue: CronJob[] = [];
const inFlightCronIds = new Set<string>();

export interface CronSchedulerDeps {
	cronStore: CronStore;
	sessionStore: SessionStore;
	workspaceManager: WorkspaceManager;
	executor: PiAgentExecutor;
	github: GitHubService;
	memoryDir: string;
	githubToken: string;
	githubUsername: string;
}

export { createSessionStateForCron };

export async function executeCronJob(deps: CronSchedulerDeps, job: CronJob, now: Date): Promise<void> {
	const cronWorktreePath = deps.workspaceManager.getCronWorktreePath(job.owner, job.repo, job.id);
	const sessionPath = path.join(deps.memoryDir, "sessions", `${job.owner}-${job.repo}-${job.id}.jsonl`);
	const branchName = deps.workspaceManager.getCronBranchName(job.id);

	let output = "";
	let error: string | null = null;
	let status: CronRunStatus = "success";

	// Generate a unique synthetic issueNumber for this cron session.
	// Negative timestamps avoid collision with real GitHub issue numbers.
	const issueNumber = -Date.now();

	const state = createSessionStateForCron(job, cronWorktreePath, sessionPath, issueNumber, now);
	await deps.sessionStore.set(state);

	try {
		const result = await runCronExecution(deps, job, state, sessionPath);
		output = result.summary || result.rawResponse || "(no output)";
		if (result.status === "cancelled") {
			status = "failure";
			error = "Task was cancelled.";
		}

		if (status === "success" && result.status === "complete") {
			try {
				const delivery = await deliverCronResult(deps, {
					job,
					state,
					result,
					output,
					issueNumber,
					cronWorktreePath,
					branchName,
				});
				output = delivery.output;
			} catch (deliveryError) {
				status = "failure";
				error = deliveryError instanceof Error ? deliveryError.message : String(deliveryError);
				output = error;
				process.stdout.write(`[cron] Delivery failed for ${job.owner}/${job.repo} cron ${job.id}: ${error}\n`);
			}
		}
	} catch (execError) {
		status = "failure";
		error = execError instanceof Error ? execError.message : String(execError);
		output = error;
		process.stdout.write(`[cron] Execution failed for ${job.owner}/${job.repo} cron ${job.id}: ${error}\n`);
	}

	await finalizeCronSessionAndRecordRun(deps, { job, state, now, status, output, error });
	await notifyCronRun(deps, job, status, output, error);
}

export async function tickCrons(deps: CronSchedulerDeps, now = new Date()): Promise<void> {
	const allJobs = await deps.cronStore.getAll();
	const dueJobs = allJobs.filter(
		(j) => j.enabled && new Date(j.nextRunAt).getTime() <= now.getTime(),
	);

	for (const job of dueJobs) {
		if (inFlightCronIds.has(job.id)) {
			continue;
		}
		inFlightCronIds.add(job.id);
		cronJobQueue.push(job);
	}

	if (isTickRunning) {
		return;
	}

	isTickRunning = true;
	try {
		while (cronJobQueue.length > 0) {
			const job = cronJobQueue.shift()!;
			try {
				await executeCronJob(deps, job, now);
			} finally {
				inFlightCronIds.delete(job.id);
			}
		}
		/* c8 ignore next 4 */
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stdout.write(`[cron] Tick failed: ${message}\n`);
	} finally {
		isTickRunning = false;
	}
}

export function startCronScheduler(deps: CronSchedulerDeps): void {
	process.stdout.write(`[cron] Starting cron scheduler (interval=${REMINDER_TICK_MS}ms)\n`);
	cronIntervalId = setInterval(() => {
		void tickCrons(deps);
	}, REMINDER_TICK_MS);
}

export function stopCronScheduler(): void {
	if (cronIntervalId) {
		clearInterval(cronIntervalId);
		cronIntervalId = undefined;
	}
}
