import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { Clock } from "../../ports/clock.js";
import { isAssignedToTars, shouldIgnoreIssueEvent } from "../../domain/workflow/policy.js";
import { ExecuteSession, type ExecuteSessionDeps } from "./execute-session.js";

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
			autoStart: boolean;
			defaultBranch: string;
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
		return this.inFlight.has(`${owner}/${repo}#${issueNumber}`);
	}

	async execute(payload: IssueEventPayload): Promise<void> {
		const owner = payload.repository.owner.login;
		const repo = payload.repository.name;
		const issue = payload.issue;
		const key = `${owner}/${repo}#${issue.number}`;

		if (payload.sender.login === this.deps.githubUsername) {
			process.stdout.write(`[webhook] issues action ignored: event from ${this.deps.githubUsername}\n`);
			return;
		}

		if (payload.action === "unassigned") {
			if (isAssignedToTars(issue, this.deps.githubUsername)) {
				process.stdout.write(`[webhook] issues.unassigned ignored: TARS still assigned to ${key}\n`);
				return;
			}
			process.stdout.write(`[webhook] issues.unassigned repo=${owner}/${repo} issue=#${issue.number} (TARS unassigned)\n`);
			const state = await this.deps.sessions.get(owner, repo, issue.number);
			if (state && (state.status === "working" || state.status === "waiting-feedback")) {
				await this.deps.sessions.updateStatus(owner, repo, issue.number, "pending");
				await this.deps.github.removeLabel(owner, repo, issue.number, "tars-working");
				await this.deps.github.removeLabel(owner, repo, issue.number, "tars-feedback-required");
				await this.deps.github.removeLabel(owner, repo, issue.number, "tars-pr-created");
				await this.deps.github.removeLabel(owner, repo, issue.number, "tars-complete");
				await this.deps.github.postComment(owner, repo, issue.number, "TARS unassigned. Pausing work.");
			}
			return;
		}

		if (payload.action === "edited") {
			const hasTarsLabel =
				(issue.labels ?? []).some((l) =>
					["tars-working", "tars-feedback-required", "tars-pr-created", "tars-complete", "tars"].includes(l.name ?? ""),
				) || issue.user?.login === this.deps.githubUsername;
			if (!isAssignedToTars(issue, this.deps.githubUsername) && !hasTarsLabel) {
				process.stdout.write(`[webhook] issues.edited ignored: not a TARS issue\n`);
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
					await this.deps.github.postComment(owner, repo, issue.number, "Issue description updated. Steering to TARS.");
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

		const check = shouldIgnoreIssueEvent(payload, this.deps.githubUsername, this.inFlight.has(key));
		if (check.ignore) {
			process.stdout.write(`[webhook] issues.${payload.action} ignored: ${check.reason}\n`);
			return;
		}

		process.stdout.write(`[webhook] issues.${payload.action} repo=${owner}/${repo} issue=#${issue.number}\n`);

		if (this.inFlight.has(key)) {
			process.stdout.write(`[webhook] ${payload.action} ignored: ${key} is already being processed\n`);
			return;
		}

		const worktree = await this.deps.workspaces.createOrGetWorktree(owner, repo, issue.number);
		const session = await this.deps.sessions.createSession(
			owner,
			repo,
			issue.number,
			issue.title,
			issue.body ?? "",
			worktree.path,
			issue.labels?.map((l) => l.name).filter((n): n is string => !!n),
		);

		if (session.status !== "pending") {
			process.stdout.write(`[webhook] ${payload.action} ignored: ${key} session status is ${session.status}\n`);
			return;
		}

		if (this.deps.tasks.isDraining()) {
			process.stdout.write(`[webhook] ${payload.action} ignored: draining mode for ${key}\n`);
			await this.deps.github.postComment(owner, repo, issue.number, "Deploy in progress. Task will resume after restart.");
			return;
		}

		if (!this.deps.autoStart) {
			process.stdout.write(`[webhook] auto-start disabled for ${repo}#${issue.number}\n`);
			return;
		}

		process.stdout.write(`[webhook] auto-starting ${repo}#${issue.number}\n`);
		this.inFlight.add(key);
		try {
			await this.deps.github.addLabels(owner, repo, issue.number, ["tars-working"]);
			await this.deps.github.postComment(owner, repo, issue.number, "Picked up by TARS. Working on it...");
			await this.executor.run(session);
		} finally {
			this.inFlight.delete(key);
		}
	}
}
