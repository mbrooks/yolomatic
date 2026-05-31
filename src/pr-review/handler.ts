import { Octokit } from "@octokit/rest";

import type { PiAgentExecutor } from "../executor/index.js";
import { GitHubClient } from "../github/client.js";
import type { SessionManager } from "../session/manager.js";
import { SessionWorkflow } from "../session/workflow.js";
import type { TaskController } from "../task-controller.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { PRReviewIterationService, type PullRequestPayload } from "./iteration-service.js";

export interface PRReviewHandlerDeps {
	sessionManager: SessionManager;
	workspaceManager: WorkspaceManager;
	executor: PiAgentExecutor;
	githubToken: string;
	githubUsername: string;
	maxIterations: number;
	octokit?: Octokit;
	taskController?: TaskController;
}

export class PRReviewHandler {
	private readonly iterationService: PRReviewIterationService;

	public constructor(private readonly deps: PRReviewHandlerDeps) {
		const octokit = deps.octokit ?? new Octokit({ auth: deps.githubToken });
		const github = new GitHubClient(octokit);
		const workflow = new SessionWorkflow(deps.sessionManager);

		this.iterationService = new PRReviewIterationService({
			workflow,
			workspaceManager: deps.workspaceManager,
			executor: deps.executor,
			github,
			githubUsername: deps.githubUsername,
			maxIterations: deps.maxIterations,
			taskController: deps.taskController,
		});
	}

	async handlePullRequestReviewCommentEvent(rawPayload: unknown): Promise<void> {
		await this.iterationService.handlePullRequestReviewCommentEvent(rawPayload as PullRequestPayload);
	}

	async handlePullRequestReviewEvent(rawPayload: unknown): Promise<void> {
		await this.iterationService.handlePullRequestReviewEvent(rawPayload as PullRequestPayload);
	}
}
