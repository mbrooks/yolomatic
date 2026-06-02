import { Octokit } from "@octokit/rest";

import type { ExecutionResult, PiAgentExecutor } from "../executor/index.js";
import type { SessionManager } from "../session/manager.js";
import type { SessionState } from "../session/store.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { TaskController } from "../task-controller.js";

import { SessionRepositoryAdapter } from "../adapters/persistence/session-repository-adapter.js";
import { WorkspaceServiceAdapter } from "../adapters/persistence/workspace-service-adapter.js";
import { ExecutionServiceAdapter } from "../adapters/persistence/execution-service-adapter.js";
import { TaskControlServiceAdapter } from "../adapters/persistence/task-control-service-adapter.js";
import { GitHubServiceAdapter } from "../adapters/github/github-service-adapter.js";
import { systemClock } from "../ports/clock.js";
import { HandleIssueEvent } from "../app/commands/handle-issue-event.js";
import { HandleIssueComment } from "../app/commands/handle-issue-comment.js";
import { HandlePRReview } from "../app/commands/handle-pr-review.js";
import { ResumeInterruptedSession } from "../app/commands/resume-interrupted-session.js";
import { ExecuteSession } from "../app/commands/execute-session.js";

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
	handleIssueEvent(payload: unknown): Promise<void>;
	handleCommentEvent(payload: unknown): Promise<void>;
	handlePullRequestReviewCommentEvent(payload: unknown): Promise<void>;
	handlePullRequestReviewEvent(payload: unknown): Promise<void>;
	isInFlight(owner: string, repo: string, issueNumber: number): boolean;
}

export class GitHubIssueHandlers implements WebhookHandlers {
	private readonly inFlight = new Set<string>();
	private readonly handleIssueEventCmd: HandleIssueEvent;
	private readonly handleIssueCommentCmd: HandleIssueComment;
	private readonly handlePRReviewCmd: HandlePRReview;
	private readonly resumeSessionCmd: ResumeInterruptedSession;

	public constructor(
		private readonly deps: {
			sessionManager: SessionManager;
			workspaceManager: WorkspaceManager;
			executor: PiAgentExecutor;
			githubToken: string;
			githubUsername: string;
			autoStart: boolean;
			defaultBranch: string;
			selfReportEnabled: boolean;
			maxIterations?: number;
			octokit?: Octokit;
			taskController?: TaskController;
			adminGithubUsername?: string;
		},
	) {
		const sessions = new SessionRepositoryAdapter(deps.sessionManager);
		const workspaces = new WorkspaceServiceAdapter(deps.workspaceManager);
		const executor = new ExecutionServiceAdapter(deps.executor);
		const tasks = new TaskControlServiceAdapter(deps.taskController ?? new TaskController());
		const github = new GitHubServiceAdapter({ githubToken: deps.githubToken, octokit: deps.octokit });

		const execDeps = {
			sessions,
			workspaces,
			executor,
			github,
			tasks,
			clock: systemClock,
			defaultBranch: deps.defaultBranch,
			githubUsername: deps.githubUsername,
			selfReportEnabled: deps.selfReportEnabled,
		};

		this.handleIssueEventCmd = new HandleIssueEvent({
			sessions,
			workspaces,
			tasks,
			github,
			clock: systemClock,
			autoStart: deps.autoStart,
			defaultBranch: deps.defaultBranch,
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
			maxIterations: deps.maxIterations ?? 3,
		});

		this.handleIssueCommentCmd = new HandleIssueComment({
			sessions,
			workspaces,
			tasks,
			github,
			autoStart: deps.autoStart,
			defaultBranch: deps.defaultBranch,
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
	}

	async handleIssueEvent(rawPayload: unknown): Promise<void> {
		const payload = rawPayload as IssuePayload;
		await this.handleIssueEventCmd.execute(payload);
	}

	async handleCommentEvent(rawPayload: unknown): Promise<void> {
		const payload = rawPayload as CommentPayload;
		await this.handleIssueCommentCmd.execute(payload);
	}

	async handlePullRequestReviewCommentEvent(payload: unknown): Promise<void> {
		await this.handlePRReviewCmd.execute(payload as import("../app/commands/handle-pr-review.js").PRReviewPayload);
	}

	async handlePullRequestReviewEvent(payload: unknown): Promise<void> {
		await this.handlePRReviewCmd.execute(payload as import("../app/commands/handle-pr-review.js").PRReviewPayload);
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
