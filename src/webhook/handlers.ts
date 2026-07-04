import { Octokit } from "@octokit/rest";

import type { ExecutionService } from "../ports/execution-service.js";
import type { SessionManager } from "../session/manager.js";
import type { SessionState } from "../session/store.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { TaskController } from "../task-controller.js";

import { GitHubServiceAdapter } from "../adapters/github/github-service-adapter.js";
import { systemClock } from "../ports/clock.js";
import { HandleIssueEvent } from "../app/commands/handle-issue-event.js";
import { HandleIssueComment } from "../app/commands/handle-issue-comment.js";
import { HandlePRReview } from "../app/commands/handle-pr-review.js";
import { ResumeInterruptedSession } from "../app/commands/resume-interrupted-session.js";
import { ExecuteSession } from "../app/commands/execute-session.js";
import { GitHubEventDispatcher } from "../github-events/dispatcher.js";
import type { GitHubEvent, GitHubEventStateStore } from "../github-events/model.js";
import { repoModeIncludesPolling, repoModeIncludesWebhook, type RepoGitHubEventMode } from "../repos/configured-repositories.js";

export interface WebhookHandlers {
	handleGitHubEvent?(event: GitHubEvent): Promise<void>;
	isInFlight(owner: string, repo: string, issueNumber: number): boolean;
}

export class GitHubIssueHandlers implements WebhookHandlers {
	private readonly inFlight = new Set<string>();
	private readonly handleIssueEventCmd: HandleIssueEvent;
	private readonly handleIssueCommentCmd: HandleIssueComment;
	private readonly handlePRReviewCmd: HandlePRReview;
	private readonly resumeSessionCmd: ResumeInterruptedSession;
	private readonly dispatcher: GitHubEventDispatcher;

	public constructor(
		private readonly deps: {
			sessionManager: SessionManager;
			workspaceManager: WorkspaceManager;
			executor: ExecutionService;
			githubToken: string;
			githubUsername: string;
			defaultBranch?: string;
			resolveDefaultBranch?: (owner: string, repo: string) => string;
			resolveGitHubEventMode?: (owner: string, repo: string) => RepoGitHubEventMode;
			selfReportEnabled: boolean;
			octokit?: Octokit;
			taskController?: TaskController;
			adminGithubUsername?: string;
			eventStore?: GitHubEventStateStore;
		},
	) {
		const sessions = deps.sessionManager;
		const workspaces = deps.workspaceManager;
		const executor = deps.executor;
		const tasks = deps.taskController ?? new TaskController();
		const github = new GitHubServiceAdapter({ githubToken: deps.githubToken, octokit: deps.octokit });

		const execDeps = {
			sessions,
			workspaces,
			executor,
			github,
			tasks,
			clock: systemClock,
			defaultBranch: deps.defaultBranch,
			resolveDefaultBranch: deps.resolveDefaultBranch,
			githubUsername: deps.githubUsername,
			selfReportEnabled: deps.selfReportEnabled,
		};

		this.handleIssueEventCmd = new HandleIssueEvent({
			sessions,
			workspaces,
			tasks,
			github,
			clock: systemClock,
			defaultBranch: deps.defaultBranch,
			resolveDefaultBranch: deps.resolveDefaultBranch,
			githubUsername: deps.githubUsername,
			selfReportEnabled: deps.selfReportEnabled,
			executor: execDeps,
			inFlight: this.inFlight,
		});

		this.handlePRReviewCmd = new HandlePRReview({
			sessions,
			workspaces,
			executor,
			github,
			tasks,
			githubUsername: deps.githubUsername,
		});

		this.handleIssueCommentCmd = new HandleIssueComment({
			sessions,
			workspaces,
			tasks,
			github,
			defaultBranch: deps.defaultBranch,
			resolveDefaultBranch: deps.resolveDefaultBranch,
			githubUsername: deps.githubUsername,
			adminGithubUsername: deps.adminGithubUsername,
			executor: execDeps,
			prReview: this.handlePRReviewCmd,
		});

		this.resumeSessionCmd = new ResumeInterruptedSession({
			sessions,
			github,
			executor: execDeps,
		});

		this.dispatcher = new GitHubEventDispatcher({
			handleIssueEvent: this.handleIssueEventCmd,
			handleIssueComment: this.handleIssueCommentCmd,
			handlePRReview: this.handlePRReviewCmd,
			eventStore: deps.eventStore,
			githubUsername: deps.githubUsername,
		});
	}

	async handleGitHubEvent(event: GitHubEvent): Promise<void> {
		if (this.deps.resolveGitHubEventMode) {
			const mode = this.deps.resolveGitHubEventMode(event.owner, event.repo);
			if (event.source === "webhook" && !repoModeIncludesWebhook(mode)) {
				process.stdout.write(`[webhook] ignored ${event.type} for ${event.owner}/${event.repo}: repo mode is ${mode}\n`);
				return;
			}
			if (event.source === "polling" && !repoModeIncludesPolling(mode)) {
				process.stdout.write(`[github-poll] ignored ${event.type} for ${event.owner}/${event.repo}: repo mode is ${mode}\n`);
				return;
			}
		}
		await this.dispatcher.dispatch(event);
	}

	async resumeInterruptedSession(owner: string, repo: string, issueNumber: number): Promise<void> {
		const key = `${owner}/${repo}#${issueNumber}`;
		this.inFlight.add(key);
		try {
			await this.resumeSessionCmd.execute(owner, repo, issueNumber);
		} finally {
			this.inFlight.delete(key);
		}
	}

	isInFlight(owner: string, repo: string, issueNumber: number): boolean {
		return this.handleIssueEventCmd.isInFlight(owner, repo, issueNumber);
	}
}
