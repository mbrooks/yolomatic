import { Octokit } from "@octokit/rest";

import type { PiAgentExecutor } from "../executor/index.js";
import { GitHubClient } from "../github/client.js";
import { AdminCommandService } from "../admin-commands/service.js";
import { IssueAssignmentService, type IssuePayload } from "../issue/assignment-service.js";
import { IssueCommentService, type CommentPayload } from "../issue/comment-service.js";
import { IssueExecutionService } from "../issue/execution-service.js";
import { PRReviewHandler } from "../pr-review/handler.js";
import type { SessionManager } from "../session/manager.js";
import { SessionWorkflow } from "../session/workflow.js";
import type { TaskController } from "../task-controller.js";
import type { WorkspaceManager } from "../workspace/manager.js";

export interface WebhookHandlers {
	handleIssueEvent(payload: unknown): Promise<void>;
	handleCommentEvent(payload: unknown): Promise<void>;
	handlePullRequestReviewCommentEvent(payload: unknown): Promise<void>;
	handlePullRequestReviewEvent(payload: unknown): Promise<void>;
}

export class GitHubIssueHandlers implements WebhookHandlers {
	private readonly assignmentService: IssueAssignmentService;
	private readonly commentService: IssueCommentService;
	private readonly prReviewHandler: PRReviewHandler;

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
		const octokit = deps.octokit ?? new Octokit({ auth: deps.githubToken });
		const github = new GitHubClient(octokit);
		const workflow = new SessionWorkflow(deps.sessionManager);
		const executionService = new IssueExecutionService({
			workflow,
			workspaceManager: deps.workspaceManager,
			executor: deps.executor,
			github,
			taskController: deps.taskController,
			selfReportEnabled: deps.selfReportEnabled,
			defaultBranch: deps.defaultBranch,
		});
		const adminCommands = new AdminCommandService({
			workflow,
			github,
			taskController: deps.taskController,
			adminGithubUsername: deps.adminGithubUsername,
		});

		this.prReviewHandler = new PRReviewHandler({
			sessionManager: deps.sessionManager,
			workspaceManager: deps.workspaceManager,
			executor: deps.executor,
			githubToken: deps.githubToken,
			githubUsername: deps.githubUsername,
			maxIterations: deps.maxIterations ?? 3,
			octokit,
			taskController: deps.taskController,
		});

		this.assignmentService = new IssueAssignmentService({
			workflow,
			workspaceManager: deps.workspaceManager,
			executionService,
			github,
			githubUsername: deps.githubUsername,
			autoStart: deps.autoStart,
		});

		this.commentService = new IssueCommentService({
			workflow,
			workspaceManager: deps.workspaceManager,
			executionService,
			github,
			prReviewHandler: this.prReviewHandler,
			adminCommands,
			githubUsername: deps.githubUsername,
		});
	}

	async handleIssueEvent(payload: unknown): Promise<void> {
		await this.assignmentService.handleIssueEvent(payload as IssuePayload);
	}

	async handleCommentEvent(payload: unknown): Promise<void> {
		await this.commentService.handleCommentEvent(payload as CommentPayload);
	}

	async handlePullRequestReviewCommentEvent(payload: unknown): Promise<void> {
		return this.prReviewHandler.handlePullRequestReviewCommentEvent(payload);
	}

	async handlePullRequestReviewEvent(payload: unknown): Promise<void> {
		return this.prReviewHandler.handlePullRequestReviewEvent(payload);
	}
}
