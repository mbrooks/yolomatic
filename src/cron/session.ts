import type { CronJob } from "./store.js";
import type { SessionState } from "../session/store.js";

export function buildCronPrompt(job: CronJob): string {
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
