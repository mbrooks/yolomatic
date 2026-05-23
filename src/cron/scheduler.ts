import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CronJob, CronRun } from "./store.js";
import { CronStore, computeNextRunAt } from "./store.js";
import { generateCommitMessage } from "../workspace/manager.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { PiAgentExecutor } from "../executor/index.js";
import type { GitHubService } from "../ports/github-service.js";
import type { SessionState, SessionStore } from "../session/store.js";

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

function buildCronPrompt(job: CronJob): string {
	return [
		`You are executing a scheduled cron job for ${job.owner}/${job.repo}.`,
		`Branch: ${job.branch}`,
		"",
		"Status protocol:",
		"- First line must be exactly one of:",
		"  TARS_STATUS: working",
		"  TARS_STATUS: waiting-feedback",
		"  TARS_STATUS: complete",
		"- If you need human clarification, ask the question immediately after the status line.",
		"- If complete, summarize what code was generated after the status line.",
		"",
		"When you mark TARS_STATUS: complete, do not commit, push, or open a Pull Request yourself.",
		"The host process owns delivery and will publish your completed branch after the run finishes.",
		"",
		`Cron job: ${job.name}`,
		"Instructions:",
		job.prompt.trim() || "(no instructions provided)",
	].join("\n");
}

export function createSessionStateForCron(
	job: CronJob,
	workspacePath: string,
	sessionPath: string,
	issueNumber: number,
	triggerTime: Date,
): SessionState {
	return {
		owner: job.owner,
		repo: job.repo,
		issueNumber,
		title: `Cron: ${job.name}`,
		body: job.prompt,
		status: "working",
		sessionPath,
		workspacePath,
		lastActivity: new Date().toISOString(),
		createdAt: new Date().toISOString(),
		seeded: true,
		sessionTag: `${job.repo}-cron-${job.id}`,
		sessionType: "cron",
		branch: `tars/cron-${job.id}`,
		cronJobId: job.id,
		cronJobName: job.name,
		cronScheduleExpression: `${job.scheduleType}:${job.scheduleValue}`,
		cronTriggerTime: triggerTime.toISOString(),
	};
}

export async function executeCronJob(deps: CronSchedulerDeps, job: CronJob, now: Date): Promise<void> {
	const worktreePath = deps.workspaceManager.getWorktreePath(job.owner, job.repo, 0);
	const cronWorktreePath = path.join(path.dirname(worktreePath), `cron-${job.id}`);
	const sessionPath = path.join(deps.memoryDir, "sessions", `${job.owner}-${job.repo}-${job.id}.jsonl`);
	const branchName = `tars/cron-${job.id}`;

	let output = "";
	let error: string | null = null;
	let status: "success" | "failure" = "success";

	// Generate a unique synthetic issueNumber for this cron session.
	// Negative timestamps avoid collision with real GitHub issue numbers.
	const issueNumber = -Date.now();

	const state = createSessionStateForCron(job, cronWorktreePath, sessionPath, issueNumber, now);
	await deps.sessionStore.set(state);

	try {
		// Ensure bare repo exists
		const bareRepoPath = deps.workspaceManager.getBareRepoPath(job.owner, job.repo);
		await mkdir(path.dirname(bareRepoPath), { recursive: true });

		// Fetch latest
		try {
			const { execFile } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const execFileAsync = promisify(execFile);
			await execFileAsync("git", ["fetch", "origin"], { cwd: bareRepoPath });
		} catch {
			// bare repo may not exist yet; workspace manager will fix below
		}

		// Use workspace manager to ensure the repo bare clone exists
		// We need a worktree for the cron job
		// Create the worktree manually since WorkspaceManager.createOrGetWorktree is issue-specific
		const normalizedOwner = job.owner.trim();
		const normalizedRepo = job.repo.trim();
		const repoBarePath = deps.workspaceManager.getBareRepoPath(normalizedOwner, normalizedRepo);

		// Ensure bare repo
		try {
			const { execFile } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const execFileAsync = promisify(execFile);
			await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: repoBarePath });
		} catch {
			// Need to create bare repo via workspace manager's logic
			// Trigger by creating a dummy issue worktree which ensures bare repo
			await deps.workspaceManager.createOrGetWorktree(normalizedOwner, normalizedRepo, 999999);
			// Remove the dummy worktree
			await deps.workspaceManager.removeWorktree(normalizedOwner, normalizedRepo, 999999);
		}

		// Now set up cron worktree
		await mkdir(path.dirname(cronWorktreePath), { recursive: true });
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const execFileAsync = promisify(execFile);

		// Determine whether the cron worktree already exists on disk.
		// Checking the filesystem is more reliable than parsing git worktree list,
		// because stale worktree registry entries can mislead us.
		let worktreeDirExists = false;
		try {
			const stats = await stat(cronWorktreePath);
			worktreeDirExists = stats.isDirectory();
		} catch {
			// ignore
		}

		const remoteBranch = `origin/${job.branch || "main"}`;
		if (worktreeDirExists) {
			await execFileAsync("git", ["checkout", "-f", branchName], { cwd: cronWorktreePath });
			await execFileAsync("git", ["reset", "--hard", remoteBranch], { cwd: cronWorktreePath });
			await execFileAsync("git", ["clean", "-fd"], { cwd: cronWorktreePath });
		} else {
			// Directory is missing, so prune any stale worktree references
			// and delete the local branch before creating a fresh worktree.
			try {
				await execFileAsync("git", ["worktree", "prune", "--expire=now"], { cwd: repoBarePath });
			} catch {
				// ignore
			}
			try {
				await execFileAsync("git", ["branch", "-D", branchName], { cwd: repoBarePath });
			} catch {
				// ignore
			}
			await execFileAsync("git", ["worktree", "add", cronWorktreePath, "-b", branchName, remoteBranch], { cwd: repoBarePath });
		}

		// Set git identity
		await execFileAsync("git", ["config", "user.name", "TARS"], { cwd: cronWorktreePath });
		await execFileAsync("git", ["config", "user.email", `${deps.githubUsername}@users.noreply.github.com`], { cwd: cronWorktreePath });

		const prompt = buildCronPrompt(job);

		await mkdir(path.dirname(sessionPath), { recursive: true });

		// Write a simple wrapper that overrides the prompt
		// Since PiAgentExecutor.buildIssuePrompt uses state, we'll create a custom executor call
		const result = await deps.executor.execute(
			state,
			undefined,
			undefined,
			undefined,
			undefined,
			prompt,
		);

		output = result.summary || result.rawResponse || "(no output)";
		if (result.status === "cancelled") {
			status = "failure";
			error = "Task was cancelled.";
		}

		// Deliver changes if the agent completed successfully
		if (status === "success" && result.status === "complete") {
			const commitMessage = generateCommitMessage(undefined, issueNumber, result.summary);
			try {
				const pushed = await deps.workspaceManager.commitAndPushPath(
					cronWorktreePath,
					branchName,
					commitMessage,
					job.branch,
				);

				if (pushed) {
					const prTitle = `TARS: ${job.name}`;
					const prBody = `Cron job: ${job.name}\n\n${result.summary || output}`;
					const base = job.branch || "main";
					try {
						const pr = await deps.github.createPullRequest(
							job.owner,
							job.repo,
							prTitle,
							prBody,
							branchName,
							base,
						);
						if (pr) {
							output = `PR created: ${pr.html_url}\n\n${output}`;
							state.prNumber = pr.number;
							state.prUrl = pr.html_url;
						} else {
							output = `No PR created (no commits).\n\n${output}`;
						}
					} catch (prError) {
						const prMessage = prError instanceof Error ? prError.message : String(prError);
						if (prMessage.includes("A pull request already exists")) {
							const existing = await deps.github.listPullRequests(job.owner, job.repo, {
								head: `${job.owner}:${branchName}`,
								base,
								state: "open",
							});
							if (existing.length > 0) {
								output = `PR already exists: ${existing[0].html_url}\n\n${output}`;
								state.prNumber = existing[0].number;
								state.prUrl = existing[0].html_url;
							} else {
								throw prError;
							}
						} else if (prMessage.includes("No commits between")) {
							output = `No PR created (no changes).\n\n${output}`;
						} else {
							throw prError;
						}
					}
				} else {
					output = `No changes to deliver.\n\n${output}`;
				}
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

	// Update session status after execution
	state.status = status === "success" ? "complete" : "failed";
	state.lastActivity = new Date().toISOString();
	if (error) {
		state.summary = error;
	} else if (output) {
		state.summary = output;
	}
	await deps.sessionStore.set(state);

	// Record run
	const run: CronRun = {
		id: randomUUID(),
		cronId: job.id,
		owner: job.owner,
		repo: job.repo,
		startedAt: now.toISOString(),
		finishedAt: new Date().toISOString(),
		status,
		output,
		error,
	};
	await deps.cronStore.addRun(run);

	// Update job state
	job.lastRunAt = now.toISOString();
	job.lastRunStatus = status;
	job.lastError = error;
	if (status === "success") {
		job.nextRunAt = computeNextRunAt(job.scheduleType, job.scheduleValue, now);
	} else {
		// Retry same schedule from now
		job.nextRunAt = computeNextRunAt(job.scheduleType, job.scheduleValue, now);
	}
	await deps.cronStore.set(job);

	// Post to notification channel if configured
	if (job.notificationChannel) {
		try {
			// If notificationChannel looks like "issue:123", post a comment
			const issueMatch = /^issue:(\d+)$/u.exec(job.notificationChannel);
			if (issueMatch) {
				const issueNumber = Number.parseInt(issueMatch[1], 10);
				const body = [
					`**Cron job: ${job.name}**`,
					`Status: ${status === "success" ? "✅ Success" : "❌ Failed"}`,
					"",
					"Output:",
					output.slice(0, 4000) || "(no output)",
					...(error ? ["", `Error: ${error}`] : []),
				].join("\n");
				await deps.github.postComment(job.owner, job.repo, issueNumber, body);
			}
		} catch (notifyError) {
			const message = notifyError instanceof Error ? notifyError.message : String(notifyError);
			process.stdout.write(`[cron] Failed to notify for ${job.id}: ${message}\n`);
		}
	}
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
			const job = cronJobQueue.shift();
			if (!job) {
				continue;
			}
			try {
				await executeCronJob(deps, job, now);
			} finally {
				inFlightCronIds.delete(job.id);
			}
		}
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
