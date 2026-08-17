import type { SessionRepository } from "../../ports/session-repository.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { GitHubService } from "../../ports/github-service.js";
import type { ExecutionService } from "../../ports/execution-service.js";
import type { Clock } from "../../ports/clock.js";
import type { MetricsRecorder } from "../../ports/metrics-recorder.js";
import { ExecuteSession } from "./execute-session.js";
import { ensureSessionExists, issueSessionKey, startIssueExecution } from "./workflow-helpers.js";
import { resolveAdminSessionUrl } from "./comment-links.js";
import { fail, ok, type AppResult } from "../result.js";

export interface StartIssueSessionResult {
	started: boolean;
	status: string;
	message: string;
}

export interface StartIssueSessionDeps {
	sessions: SessionRepository;
	workspaces: WorkspaceService;
	github: GitHubService;
	tasks: TaskControlService;
	executor: ExecutionService;
	clock: Clock;
	defaultBranch: string;
	resolveDefaultBranch?: (owner: string, repo: string) => string;
	githubUsername: string;
	selfReportEnabled: boolean;
	issueAdminLinkInCommentsEnabled?: boolean;
	adminBaseUrl?: string;
	resolveAdminBaseUrl?: () => string | undefined;
	resolveIssueAdminLinkInCommentsEnabled?: () => boolean | undefined;
	/** Optional recorder for per-execution metrics (runtime + token usage). */
	metrics?: MetricsRecorder;
}

export class StartIssueSession {
	constructor(
		private readonly sessions: SessionRepository,
		private readonly workspaces: WorkspaceService,
		private readonly github: GitHubService,
		private readonly tasks: TaskControlService,
		private readonly executor: ExecutionService,
		private readonly clock: Clock,
		private readonly defaultBranchOrResolver: string | ((owner: string, repo: string) => string),
		private readonly githubUsername: string,
		private readonly selfReportEnabled: boolean,
		private readonly adminLink: {
			adminBaseUrl?: string;
			resolveAdminBaseUrl?: () => string | undefined;
			issueAdminLinkInCommentsEnabled?: boolean;
			resolveIssueAdminLinkInCommentsEnabled?: () => boolean | undefined;
		} = {},
		private readonly metrics?: MetricsRecorder,
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
			const defaultBranch =
				typeof this.defaultBranchOrResolver === "function"
					? this.defaultBranchOrResolver(owner, repo)
					: this.defaultBranchOrResolver;
			const activeRefinement = await this.sessions.get(owner, repo, issueNumber, "refinement");

			if (activeRefinement?.kind === "refinement" && activeRefinement.status === "working") {
				return fail("conflict", "Issue refinement is currently running");
			}

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
				defaultBranch,
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
				defaultBranch,
				resolveDefaultBranch:
					typeof this.defaultBranchOrResolver === "function"
						? this.defaultBranchOrResolver
						: undefined,
				githubUsername: this.githubUsername,
				selfReportEnabled: this.selfReportEnabled,
				metrics: this.metrics,
			};

			const executor = new ExecuteSession(execDeps);

			await startIssueExecution(
				executor,
				this.github,
				owner,
				repo,
				issueNumber,
				session,
				"Picked up by Yolomatic. Working on it...",
				undefined,
				this.adminSessionUrl(owner, repo, issueNumber),
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

	private adminSessionUrl(owner: string, repo: string, issueNumber: number): string | undefined {
		const adminBaseUrl = this.adminLink.resolveAdminBaseUrl?.() ?? this.adminLink.adminBaseUrl;
		const issueAdminLinkInCommentsEnabled =
			this.adminLink.resolveIssueAdminLinkInCommentsEnabled?.() ?? this.adminLink.issueAdminLinkInCommentsEnabled;
		return resolveAdminSessionUrl(
			adminBaseUrl,
			issueAdminLinkInCommentsEnabled,
			owner,
			repo,
			issueNumber,
			"implementation",
		);
	}
}

export function createStartIssueSession(deps: StartIssueSessionDeps): StartIssueSession {
	return new StartIssueSession(
		deps.sessions,
		deps.workspaces,
		deps.github,
		deps.tasks,
		deps.executor,
		deps.clock,
		deps.resolveDefaultBranch ?? deps.defaultBranch,
		deps.githubUsername,
		deps.selfReportEnabled,
		{
			adminBaseUrl: deps.adminBaseUrl,
			resolveAdminBaseUrl: deps.resolveAdminBaseUrl,
			issueAdminLinkInCommentsEnabled: deps.issueAdminLinkInCommentsEnabled,
			resolveIssueAdminLinkInCommentsEnabled: deps.resolveIssueAdminLinkInCommentsEnabled,
		},
		deps.metrics,
	);
}
