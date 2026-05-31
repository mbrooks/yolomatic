import type { GitHubClient } from "../github/client.js";
import type { SessionWorkflow } from "../session/workflow.js";
import type { TaskController } from "../task-controller.js";

export interface StopCommandTarget {
	owner: string;
	repo: string;
	issueNumber: number;
	commentTargetNumber: number;
	senderLogin: string;
}

export class AdminCommandService {
	public constructor(
		private readonly deps: {
			workflow: SessionWorkflow;
			github: GitHubClient;
			taskController?: TaskController;
			adminGithubUsername?: string;
		},
	) {}

	isAdmin(login: string): boolean {
		return !!this.deps.adminGithubUsername && login === this.deps.adminGithubUsername;
	}

	async handleStopCommand(target: StopCommandTarget): Promise<void> {
		const { owner, repo, issueNumber, commentTargetNumber, senderLogin } = target;
		if (!this.isAdmin(senderLogin)) {
			process.stdout.write(`[webhook] issue_comment ignored for ${repo}#${commentTargetNumber}: /tars stop from non-admin\n`);
			await this.deps.github.createComment(owner, repo, commentTargetNumber, "Only admins can stop TARS.");
			return;
		}

		const inFlightKey = `${owner}/${repo}#${issueNumber}`;
		process.stdout.write(`[webhook] issue_comment stop command for ${repo}#${commentTargetNumber} mapped to ${inFlightKey} from admin\n`);
		const cancelledInFlight = this.deps.taskController?.cancel(inFlightKey) ?? false;
		if (cancelledInFlight) {
			await this.deps.github.createComment(owner, repo, commentTargetNumber, "Stopping TARS...");
			return;
		}

		const session = await this.deps.workflow.getSession(owner, repo, issueNumber);
		if (session && session.status === "working") {
			await this.deps.workflow.cancelSession(owner, repo, issueNumber);
			await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-working");
			await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-cancelled"]);
			await this.deps.github.createComment(owner, repo, commentTargetNumber, "Task cancelled by admin. TARS is idle.");
			process.stdout.write(`[webhook] stopped ${inFlightKey} (not in-flight)\n`);
			return;
		}

		await this.deps.github.createComment(owner, repo, commentTargetNumber, "TARS is not currently working on this issue.");
	}
}
