import { Octokit } from "@octokit/rest";

import type { ExecutionService } from "../ports/execution-service.js";
import type { SessionRepository } from "../ports/session-repository.js";
import type { SessionState } from "../session/store.js";
import type { WorkspaceService } from "../ports/workspace-service.js";
import { TaskController } from "../task-controller.js";
import { DockerWorkerExecutor } from "../executor/docker-worker.js";

import { GitHubServiceAdapter } from "../adapters/github/github-service-adapter.js";
import { systemClock } from "../ports/clock.js";
import { HandleIssueEvent } from "../app/commands/handle-issue-event.js";
import { HandleIssueComment } from "../app/commands/handle-issue-comment.js";
import { HandleIssueRefinement } from "../app/commands/handle-issue-refinement.js";
import { HandlePRReview } from "../app/commands/handle-pr-review.js";
import { HandleFixMergeConflicts } from "../app/commands/handle-fix-merge-conflicts.js";
import { HandleAutoRebaseOnPush } from "../app/commands/handle-auto-rebase-on-push.js";
import { ResumeInterruptedSession } from "../app/commands/resume-interrupted-session.js";
import { ExecuteSession } from "../app/commands/execute-session.js";
import { GitHubEventDispatcher } from "../github-events/dispatcher.js";
import type { GitHubEvent, GitHubEventStateStore } from "../github-events/model.js";
import { repoModeIncludesPolling, repoModeIncludesWebhook, type RepoGitHubEventMode } from "../repos/repository.js";
import { RefinementStore } from "../refinement/store.js";
import { RepositoryStore } from "../repos/repository-store.js";
import path from "node:path";
import { repoKey } from "../repos/repository.js";
import type { MetricsRecorder } from "../ports/metrics-recorder.js";

export interface WebhookHandlers {
	handleGitHubEvent?(event: GitHubEvent): Promise<void>;
	isInFlight(owner: string, repo: string, issueNumber: number): boolean;
}

export class GitHubIssueHandlers implements WebhookHandlers {
	private readonly inFlight = new Set<string>();
	private readonly handleIssueEventCmd: HandleIssueEvent;
	private readonly handleIssueCommentCmd: HandleIssueComment;
	private readonly handlePRReviewCmd: HandlePRReview;
	private readonly handleIssueRefinementCmd: HandleIssueRefinement;
	private readonly resumeSessionCmd: ResumeInterruptedSession;
	private readonly dispatcher: GitHubEventDispatcher;

	public constructor(
		private readonly deps: {
			sessionManager: SessionRepository;
			workspaceManager: WorkspaceService;
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
			memoryDir?: string;
			repositoryStore?: RepositoryStore;
			refinementStore?: RefinementStore;
			issueNewCommentEnabled?: boolean;
			issueAdminLinkInCommentsEnabled?: boolean;
			adminBaseUrl?: string;
			resolveAdminBaseUrl?: () => string | undefined;
			resolveIssueAdminLinkInCommentsEnabled?: () => boolean | undefined;
			maxConflictAttempts?: number;
			mergeabilityPollDelayMs?: number;
			mergeabilityPollMaxAttempts?: number;
			/** Optional recorder for per-execution metrics (runtime + token usage). */
			metrics?: MetricsRecorder;
		},
	) {
		const sessions = deps.sessionManager;
		const workspaces = deps.workspaceManager;
		const executor = deps.executor;
		const tasks = deps.taskController ?? new TaskController();
		const github = new GitHubServiceAdapter({ githubToken: deps.githubToken, octokit: deps.octokit });

		const refinementStore =
			deps.refinementStore ??
			(deps.memoryDir
				? new RefinementStore(path.join(deps.memoryDir, "bot-state.sqlite"))
				: new RefinementStore(path.join(process.cwd(), "memory", "bot-state.sqlite")));
		const isRepoManaged = (owner: string, repo: string) => {
			if (!deps.repositoryStore) return true;
			return !!deps.repositoryStore.getSync(owner, repo);
		};
		const refinement = new HandleIssueRefinement({
			refinementStore,
			sessions,
			github,
			tasks,
			workspaces,
			executor: deps.executor as DockerWorkerExecutor,
			clock: systemClock,
			eventStore: deps.eventStore,
			adminGithubUsername: deps.adminGithubUsername,
			githubUsername: deps.githubUsername,
			defaultBranch: deps.defaultBranch,
			resolveDefaultBranch: deps.resolveDefaultBranch,
			isRepoManaged,
			issueNewCommentEnabled: deps.issueNewCommentEnabled,
			issueAdminLinkInCommentsEnabled: deps.issueAdminLinkInCommentsEnabled,
			adminBaseUrl: deps.adminBaseUrl,
			resolveAdminBaseUrl: deps.resolveAdminBaseUrl,
			resolveIssueAdminLinkInCommentsEnabled: deps.resolveIssueAdminLinkInCommentsEnabled,
			metrics: deps.metrics,
		});
		this.handleIssueRefinementCmd = refinement;

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
			issueAdminLinkInCommentsEnabled: deps.issueAdminLinkInCommentsEnabled,
			adminBaseUrl: deps.adminBaseUrl,
			resolveAdminBaseUrl: deps.resolveAdminBaseUrl,
			resolveIssueAdminLinkInCommentsEnabled: deps.resolveIssueAdminLinkInCommentsEnabled,
			metrics: deps.metrics,
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
			refinement,
			inFlight: this.inFlight,
			issueAdminLinkInCommentsEnabled: deps.issueAdminLinkInCommentsEnabled,
			adminBaseUrl: deps.adminBaseUrl,
			resolveAdminBaseUrl: deps.resolveAdminBaseUrl,
			resolveIssueAdminLinkInCommentsEnabled: deps.resolveIssueAdminLinkInCommentsEnabled,
		});

		this.handlePRReviewCmd = new HandlePRReview({
			sessions,
			workspaces,
			executor,
			github,
			tasks,
			githubUsername: deps.githubUsername,
			selfReportEnabled: deps.selfReportEnabled,
		});

		const fixMergeConflictsCmd = new HandleFixMergeConflicts({
			sessions,
			workspaces,
			executor,
			github,
			tasks,
			githubUsername: deps.githubUsername,
			adminGithubUsername: deps.adminGithubUsername,
			defaultBranch: deps.defaultBranch,
			resolveDefaultBranch: deps.resolveDefaultBranch,
			maxConflictAttempts: deps.maxConflictAttempts,
			mergeabilityPollDelayMs: deps.mergeabilityPollDelayMs,
			mergeabilityPollMaxAttempts: deps.mergeabilityPollMaxAttempts,
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
			refinement,
			prReview: this.handlePRReviewCmd,
			fixMergeConflicts: fixMergeConflictsCmd,
			issueAdminLinkInCommentsEnabled: deps.issueAdminLinkInCommentsEnabled,
			adminBaseUrl: deps.adminBaseUrl,
			resolveAdminBaseUrl: deps.resolveAdminBaseUrl,
			resolveIssueAdminLinkInCommentsEnabled: deps.resolveIssueAdminLinkInCommentsEnabled,
		});

		this.resumeSessionCmd = new ResumeInterruptedSession({
			sessions,
			github,
			executor: execDeps,
		});

		const autoRebaseCmd = new HandleAutoRebaseOnPush({
			sessions,
			workspaces,
			executor,
			github,
			tasks,
			githubUsername: deps.githubUsername,
			defaultBranch: deps.defaultBranch,
			resolveDefaultBranch: deps.resolveDefaultBranch,
			maxConflictAttempts: deps.maxConflictAttempts,
			mergeabilityPollDelayMs: deps.mergeabilityPollDelayMs,
			mergeabilityPollMaxAttempts: deps.mergeabilityPollMaxAttempts,
		});

		this.dispatcher = new GitHubEventDispatcher({
			handleIssueEvent: this.handleIssueEventCmd,
			handleIssueComment: this.handleIssueCommentCmd,
			handlePRReview: this.handlePRReviewCmd,
			handleAutoRebase: autoRebaseCmd,
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

	async restartRefinement(owner: string, repo: string, issueNumber: number): Promise<void> {
		await this.handleIssueRefinementCmd.restart(owner, repo, issueNumber);
	}

	isInFlight(owner: string, repo: string, issueNumber: number): boolean {
		return this.handleIssueEventCmd.isInFlight(owner, repo, issueNumber);
	}
}
