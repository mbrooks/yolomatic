import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { ExecutionService } from "../../ports/execution-service.js";
import type { Clock } from "../../ports/clock.js";
import { ExecuteSession } from "./execute-session.js";
import { ensureSessionExists, issueSessionKey, startIssueExecution } from "./workflow-helpers.js";
import { fail, ok, type AppResult } from "../result.js";

export interface StartIssueSessionResult {
	started: boolean;
	status: string;
	message: string;
}

export class StartIssueSession {
	constructor(
		private readonly sessions: SessionRepository,
		private readonly workspaces: WorkspaceService,
		private readonly github: GitHubService,
		private readonly tasks: TaskControlService,
		private readonly executor: ExecutionService,
		private readonly clock: Clock,
		private readonly defaultBranch: string,
		private readonly githubUsername: string,
		private readonly selfReportEnabled: boolean,
	) {}

	async execute(
		owner: string,
		repo: string,
		issueNumber: number,
		title: string,
		body: string,
		labels: string[],
	): Promise<AppResult<StartIssueSessionResult>> {
		try {
			const key = issueSessionKey(owner, repo, issueNumber);

			if (this.tasks.isActive(key)) {
				return fail("conflict", "Session is already being executed");
			}

			await this.github.updateIssueAssignees(owner, repo, issueNumber, [this.githubUsername]);

			const session = await ensureSessionExists(
				this.sessions,
				this.workspaces,
				this.github,
				owner,
				repo,
				issueNumber,
				title,
				body,
				labels,
				this.defaultBranch,
			);

			if (session.status !== "pending") {
				return ok<StartIssueSessionResult>({
					started: false,
					status: session.status,
					message: `Session already exists with status ${session.status}`,
				});
			}

			const execDeps = {
				sessions: this.sessions,
				workspaces: this.workspaces,
				executor: this.executor,
				github: this.github,
				tasks: this.tasks,
				clock: this.clock,
				defaultBranch: this.defaultBranch,
				githubUsername: this.githubUsername,
				selfReportEnabled: this.selfReportEnabled,
			};

			const executor = new ExecuteSession(execDeps);

			await startIssueExecution(
				executor,
				this.github,
				owner,
				repo,
				issueNumber,
				session,
				"Picked up by TARS. Working on it...",
			);

			return ok<StartIssueSessionResult>({
				started: true,
				status: "working",
				message: "Session started successfully",
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return fail("internal", message);
		}
	}
}
