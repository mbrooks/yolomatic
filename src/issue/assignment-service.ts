import type { SessionState } from "../session/store.js";
import { SessionWorkflow } from "../session/workflow.js";
import { GitHubClient } from "../github/client.js";
import { IssueExecutionService } from "./execution-service.js";
import type { WorkspaceManager } from "../workspace/manager.js";

interface IssueLabel {
	name?: string;
}

export interface IssuePayload {
	action: string;
	issue: {
		number: number;
		title: string;
		body: string | null;
		labels?: IssueLabel[];
		assignee?: {
			login: string;
		} | null;
		assignees?: {
			login: string;
		}[];
	};
	repository: {
		name: string;
		owner: {
			login: string;
		};
	};
	sender: {
		login: string;
	};
}

export class IssueAssignmentService {
	private readonly inFlight = new Set<string>();

	public constructor(
		private readonly deps: {
			workflow: SessionWorkflow;
			workspaceManager: WorkspaceManager;
			executionService: IssueExecutionService;
			github: GitHubClient;
			githubUsername: string;
			autoStart: boolean;
		},
	) {}

	async handleIssueEvent(payload: IssuePayload): Promise<void> {
		const owner = payload.repository.owner.login;
		const repo = payload.repository.name;
		const issue = payload.issue;

		if (payload.sender.login === this.deps.githubUsername) {
			process.stdout.write(`[webhook] issues action ignored: event from ${this.deps.githubUsername}\n`);
			return;
		}

		if (payload.action === "opened") {
			if (!this.isAssignedToTars(issue)) {
				process.stdout.write(`[webhook] issues.opened ignored: not assigned to ${this.deps.githubUsername}\n`);
				return;
			}
			process.stdout.write(`[webhook] issues.opened repo=${owner}/${repo} issue=#${issue.number} (assigned)\n`);
		} else if (payload.action === "assigned") {
			if (!this.isAssignedToTars(issue)) {
				process.stdout.write(`[webhook] issues.assigned ignored: not assigned to ${this.deps.githubUsername}\n`);
				return;
			}
			process.stdout.write(`[webhook] issues.assigned repo=${owner}/${repo} issue=#${issue.number} to=${this.deps.githubUsername}\n`);
		} else if (payload.action === "unassigned") {
			if (this.isAssignedToTars(issue)) {
				process.stdout.write(`[webhook] issues.unassigned ignored: TARS still assigned to ${owner}/${repo}#${issue.number}\n`);
				return;
			}
			process.stdout.write(`[webhook] issues.unassigned repo=${owner}/${repo} issue=#${issue.number} (TARS unassigned)\n`);
			await this.handleUnassigned(owner, repo, issue.number);
			return;
		} else {
			process.stdout.write(`[webhook] issues action ignored: ${payload.action}\n`);
			return;
		}

		const inFlightKey = `${owner}/${repo}#${issue.number}`;
		if (this.inFlight.has(inFlightKey)) {
			process.stdout.write(`[webhook] ${payload.action} ignored: ${inFlightKey} is already being processed\n`);
			return;
		}

		const worktree = await this.deps.workspaceManager.createOrGetWorktree(owner, repo, issue.number);
		const session = await this.deps.workflow.createSession(
			owner,
			repo,
			issue.number,
			issue.title,
			issue.body ?? "",
			worktree.path,
			issue.labels?.map((label) => label.name).filter((name): name is string => !!name),
		);

		if (session.status !== "pending") {
			process.stdout.write(`[webhook] ${payload.action} ignored: ${inFlightKey} session status is ${session.status}\n`);
			return;
		}

		if (!this.deps.autoStart) {
			process.stdout.write(`[webhook] auto-start disabled for ${repo}#${issue.number}\n`);
			return;
		}

		process.stdout.write(`[webhook] auto-starting ${repo}#${issue.number}\n`);
		this.inFlight.add(inFlightKey);
		try {
			await this.deps.github.addLabels(owner, repo, issue.number, ["tars-working"]);
			await this.deps.github.createComment(owner, repo, issue.number, "Picked up by TARS. Working on it...");
			await this.deps.executionService.executeIssue(owner, repo, issue.number);
		} finally {
			this.inFlight.delete(inFlightKey);
		}
	}

	private isAssignedToTars(issue: { assignee?: { login: string } | null; assignees?: { login: string }[] }): boolean {
		if (issue.assignees && issue.assignees.some((assignee) => assignee.login === this.deps.githubUsername)) return true;
		if (issue.assignee?.login === this.deps.githubUsername) return true;
		return false;
	}

	private async handleUnassigned(owner: string, repo: string, issueNumber: number): Promise<void> {
		const state = await this.deps.workflow.getSession(owner, repo, issueNumber);
		if (!state || (state.status !== "working" && state.status !== "waiting-feedback")) {
			return;
		}

		await this.deps.workflow.markPending(owner, repo, issueNumber);
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-working");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-feedback-required");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-pr-created");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-complete");
		await this.deps.github.createComment(owner, repo, issueNumber, "TARS unassigned. Pausing work.");
	}
}
