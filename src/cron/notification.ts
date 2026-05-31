import type { CronJob } from "./store.js";
import type { GitHubService } from "../ports/github-service.js";
import type { CronRunStatus } from "./recording.js";

export interface CronNotificationDeps {
	github: GitHubService;
}

export async function notifyCronRun(
	deps: CronNotificationDeps,
	job: CronJob,
	status: CronRunStatus,
	output: string,
	error: string | null,
): Promise<void> {
	if (!job.notificationChannel) {
		return;
	}

	try {
		const issueMatch = /^issue:(\d+)$/u.exec(job.notificationChannel);
		if (!issueMatch) {
			return;
		}
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
	} catch (notifyError) {
		const message = notifyError instanceof Error ? notifyError.message : String(notifyError);
		process.stdout.write(`[cron] Failed to notify for ${job.id}: ${message}\n`);
	}
}
