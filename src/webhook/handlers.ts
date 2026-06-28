import { Octokit } from "@octokit/rest";

import type { SessionRepository } from "../ports/session-repository.js";
import type { ExecutionResult, PiAgentExecutor } from "../executor/index.js";
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
import { normalizeWebhookEvent } from "../adapters/github/webhook-adapter.js";
import { repoModeIncludesPolling, repoModeIncludesWebhook, type RepoGitHubEventMode } from "../repos/configured-repositories.js";

interface IssueLabel {
	name?: string;
}

interface IssuePayload {
	action: string;
	issue: {
		number: number;
		title: string;
		body: string | null;
		labels?: IssueLabel[];
		assignee?: { login: string } | null;
		assignees?: { login: string }[];
		user?: { login: string };
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
	changes?: {
		body?: { from: string };
		title?: { from: string };
	};
}

interface CommentPayload {
	action: string;
	issue: {
		number: number;
		title?: string;
		body?: string | null;
		pull_request?: {
			url: string;
		};
		labels?: IssueLabel[];
		assignee?: { login: string } | null;
		assignees?: { login: string }[];
		user?: { login: string };
	};
	comment: {
		id?: number;
		body: string;
		user: {
			login: string;
			type?: string;
		};
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

export interface WebhookHandlers {
	handleGitHubEvent?(event: GitHubEvent): Promise<void>;
	handleIssueEvent(payload: unknown): Promise<void>;
	handleCommentEvent(payload: unknown): Promise<void>;
	handlePullRequestReviewCommentEvent(payload: unknown): Promise<void>;
	handlePullRequestReviewEvent(payload: unknown): Promise<void>;
	isInFlight(owner: string, repo: string, issueNumber: number): boolean;
}

function asSessionRepository(manager: SessionManager): SessionRepository {
	return new Proxy(manager, {
		get(target, prop) {
			if (prop === "get") {
				return target.getSession.bind(target);
			}
			const value = (target as unknown as Record<string, unknown>)[prop as string];
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	}) as SessionRepository;
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
			executor: PiAgentExecutor;
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
		const sessions = asSessionRepository(deps.sessionManager);
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

	async handleIssueEvent(rawPayload: unknown): Promise<void> {
		for (const event of normalizeWebhookEvent("issues", rawPayload)) {
			await this.handleGitHubEvent(event);
		}
	}

	async handleCommentEvent(rawPayload: unknown): Promise<void> {
		for (const event of normalizeWebhookEvent("issue_comment", rawPayload)) {
			await this.handleGitHubEvent(event);
		}
	}

	async handlePullRequestReviewCommentEvent(payload: unknown): Promise<void> {
		for (const event of normalizeWebhookEvent("pull_request_review_comment", payload)) {
			await this.handleGitHubEvent(event);
		}
	}

	async handlePullRequestReviewEvent(payload: unknown): Promise<void> {
		for (const event of normalizeWebhookEvent("pull_request_review", payload)) {
			await this.handleGitHubEvent(event);
		}
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
