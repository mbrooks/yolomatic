import { generateCommitMessage } from "../workspace/commit-message.js";
import type { CronJob } from "./store.js";
import type { ExecutionResult } from "../executor/index.js";
import type { GitHubService } from "../ports/github-service.js";
import type { SessionState } from "../session/store.js";
import type { WorkspaceManager } from "../workspace/manager.js";

export interface CronDeliveryDeps {
	workspaceManager: WorkspaceManager;
	github: GitHubService;
}

export interface CronDeliveryInput {
	job: CronJob;
	state: SessionState;
	result: ExecutionResult;
	output: string;
	issueNumber: number;
	cronWorktreePath: string;
	branchName: string;
}

export interface CronDeliveryResult {
	output: string;
}

export async function deliverCronResult(
	deps: CronDeliveryDeps,
	input: CronDeliveryInput,
): Promise<CronDeliveryResult> {
	const { job, state, result, issueNumber, cronWorktreePath, branchName } = input;
	let output = input.output;
	const commitMessage = generateCommitMessage(undefined, issueNumber, result.summary);
	const pushed = await deps.workspaceManager.commitAndPushPath(
		cronWorktreePath,
		branchName,
		commitMessage,
		job.branch,
	);

	if (!pushed) {
		return { output: `No changes to deliver.\n\n${output}` };
	}

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

	return { output };
}
