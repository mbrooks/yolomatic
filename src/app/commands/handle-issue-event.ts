import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { Clock } from "../../ports/clock.js";
import { hasYeetomaticVisibleLabel, isAssignedToYeetomatic } from "../../domain/workflow/policy.js";
import { ExecuteSession, type ExecuteSessionDeps } from "./execute-session.js";
import {
	issueSessionKey,
	removeWorkflowLabels,
	startIssueExecution,
	resolveIssueContext,
	guardEvent,
	prepareIssueSession,
} from "./workflow-helpers.js";

export interface IssueEventPayload {
	action: string;
	issue: {
		number: number;
		title: string;
		body: string | null;
		labels?: Array<{ name?: string }>;
		assignee?: { login: string } | null;
		assignees?: { login: string }[];
		user?: { login: string };
	};
	repository: { name: string; owner: { login: string } };
	sender: { login: string };
}

export class HandleIssueEvent {
	private readonly executor: ExecuteSession;
	private readonly inFlight: Set<string>;

	constructor(
		private readonly deps: {
			sessions: SessionRepository;
			workspaces: WorkspaceService;
			tasks: TaskControlService;
			github: GitHubService;
			clock: Clock;
			defaultBranch?: string;
			resolveDefaultBranch?: (owner: string, repo: string) => string;
			githubUsername: string;
			selfReportEnabled: boolean;
			executor: ExecuteSessionDeps;
			inFlight?: Set<string>;
		},
	) {
		this.executor = new ExecuteSession(deps.executor);
		this.inFlight = deps.inFlight ?? new Set<string>();
	}

	isInFlight(owner: string, repo: string, issueNumber: number): boolean {
		return this.inFlight.has(issueSessionKey(owner, repo, issueNumber));
	}

	async execute(payload: IssueEventPayload): Promise<void> {
		const ctx = resolveIssueContext(payload, this.deps.resolveDefaultBranch, this.deps.defaultBranch);
		const { owner, repo, key } = ctx;
		const issue = payload.issue;

		if (payload.sender.login === this.deps.githubUsername) {
			process.stdout.write(`[webhook] issues action ignored: event from ${this.deps.githubUsername}\n`);
			return;
		}

		if (payload.action === "unassigned") {
			if (isAssignedToYeetomatic(issue, this.deps.githubUsername)) {
				process.stdout.write(`[webhook] issues.unassigned ignored: Yeetomatic still assigned to ${key}\n`);
				return;
			}
			process.stdout.write(`[webhook] issues.unassigned repo=${owner}/${repo} issue=#${issue.number} (Yeetomatic unassigned)\n`);
			const state = await this.deps.sessions.get(owner, repo, issue.number);
			if (state && (state.status === "working" || state.status === "waiting-feedback")) {
				await this.deps.sessions.updateStatus(owner, repo, issue.number, "pending");
				await removeWorkflowLabels(this.deps.github, owner, repo, issue.number);
				await this.deps.github.postComment(owner, repo, issue.number, "Yeetomatic unassigned. Pausing work.");
			}
			return;
		}

		if (payload.action === "edited") {
			const hasYeetomaticLabel = hasYeetomaticVisibleLabel(issue.labels) || issue.user?.login === this.deps.githubUsername;
			if (!isAssignedToYeetomatic(issue, this.deps.githubUsername) && !hasYeetomaticLabel) {
				process.stdout.write(`[webhook] issues.edited ignored: not a Yeetomatic issue\n`);
				return;
			}
			const state = await this.deps.sessions.get(owner, repo, issue.number);
			if (!state) {
				process.stdout.write(`[webhook] issues.edited ignored: no session for ${key}\n`);
				return;
			}
			if (this.deps.tasks.isActive(key)) {
				const steered = await this.deps.tasks.steer(key, issue.body ?? "");
				if (steered) {
					process.stdout.write(`[webhook] steered description update on active execution ${key}\n`);
					await this.deps.github.postComment(owner, repo, issue.number, "Issue description updated. Steering to Yeetomatic.");
				} else {
					await this.deps.github.postComment(owner, repo, issue.number, "Issue description updated but could not be steered.");
				}
				return;
			}
			await this.deps.sessions.updateStatus(owner, repo, issue.number, state.status, {
				body: issue.body ?? "",
				title: issue.title,
			});
			process.stdout.write(`[webhook] updated session body/title for ${key}\n`);
			return;
		}

		if (payload.action !== "opened" && payload.action !== "assigned") {
			process.stdout.write(`[webhook] issues action ignored: ${payload.action}\n`);
			return;
		}

		const guard = guardEvent("issues", payload, this.deps.githubUsername, this.inFlight.has(key));
		if (guard.skip) {
			process.stdout.write(`[webhook] issues.${payload.action} ignored: ${guard.reason}\n`);
			return;
		}

		process.stdout.write(`[webhook] issues.${payload.action} repo=${owner}/${repo} issue=#${issue.number}\n`);

		if (this.inFlight.has(key)) {
			process.stdout.write(`[webhook] ${payload.action} ignored: ${key} is already being processed\n`);
			return;
		}

		this.inFlight.add(key);

		try {
			const prepared = await prepareIssueSession(
				{
					sessions: this.deps.sessions,
					workspaces: this.deps.workspaces,
					github: this.deps.github,
					tasks: this.deps.tasks,
				},
				{
					owner,
					repo,
					issueNumber: issue.number,
					title: issue.title,
					body: issue.body ?? "",
					labels: issue.labels?.map((l) => l.name).filter((n): n is string => !!n),
					defaultBranch: ctx.defaultBranch,
				},
				{ requirePending: true },
			);

			if (prepared.skip) {
				if (prepared.kind === "status") {
					process.stdout.write(`[webhook] ${payload.action} ignored: ${key} session status is ${prepared.status}\n`);
				} else {
					process.stdout.write(`[webhook] ${payload.action} ignored: draining mode for ${key}\n`);
				}
				return;
			}

			process.stdout.write(`[webhook] auto-starting ${repo}#${issue.number}\n`);
			await startIssueExecution(
				this.executor,
				this.deps.github,
				owner,
				repo,
				issue.number,
				prepared.session,
				"Picked up by Yeetomatic. Working on it...",
			);
		} finally {
			this.inFlight.delete(key);
		}
	}
}
