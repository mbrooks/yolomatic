import type { ExecutionService, RefinementExecutionService } from "../ports/execution-service.js";
import type { SessionRepository } from "../ports/session-repository.js";
import type { WorkspaceService } from "../ports/workspace-service.js";
import type { GitHubService } from "../ports/github-service.js";
import type { TaskControlService } from "../ports/task-control-service.js";
import type { Clock } from "../ports/clock.js";
import type { MetricsRecorder } from "../ports/metrics-recorder.js";

import { systemClock } from "../ports/clock.js";
import { HandleIssueEvent } from "./commands/handle-issue-event.js";
import { HandleIssueComment } from "./commands/handle-issue-comment.js";
import { HandleIssueRefinement } from "./commands/handle-issue-refinement.js";
import { HandlePRReview } from "./commands/handle-pr-review.js";
import { HandleFixMergeConflicts } from "./commands/handle-fix-merge-conflicts.js";
import { HandleAutoRebaseOnPush } from "./commands/handle-auto-rebase-on-push.js";
import { ResumeInterruptedSession } from "./commands/resume-interrupted-session.js";
import { GitHubEventDispatcher } from "../github-events/dispatcher.js";
import type { GitHubEventStateStore } from "../github-events/model.js";
import type { RepoGitHubEventMode } from "../repos/repository.js";
import type { RefinementStore } from "../refinement/store.js";
import { RepositoryStore } from "../repos/repository-store.js";
import { GitHubIssueHandlers } from "../webhook/handlers.js";

/**
 * Dependencies for {@link createGitHubEventApplication}. The GitHub service
 * adapter, Octokit client, session/workspace/task collaborators, and stores
 * are constructed at the composition root and injected here. The factory only
 * wires the application commands and the event dispatcher — it does not
 * construct infrastructure adapters.
 */
export interface GitHubEventApplicationDeps {
	sessions: SessionRepository;
	workspaces: WorkspaceService;
	executor: ExecutionService & RefinementExecutionService;
	github: GitHubService;
	tasks: TaskControlService;
	clock?: Clock;
	githubUsername: string;
	adminGithubUsername?: string;
	defaultBranch?: string;
	resolveDefaultBranch?: (owner: string, repo: string) => string;
	resolveGitHubEventMode?: (owner: string, repo: string) => RepoGitHubEventMode;
	selfReportEnabled: boolean;
	eventStore?: GitHubEventStateStore;
	refinementStore: RefinementStore;
	repositoryStore?: RepositoryStore;
	issueNewCommentEnabled?: boolean;
	issueAdminLinkInCommentsEnabled?: boolean;
	adminBaseUrl?: string;
	resolveAdminBaseUrl?: () => string | undefined;
	resolveIssueNewCommentEnabled?: (owner: string, repo: string) => boolean | undefined;
	resolveIssueAdminLinkInCommentsEnabled?: (owner: string, repo: string) => boolean | undefined;
	maxConflictAttempts?: number;
	mergeabilityPollDelayMs?: number;
	mergeabilityPollMaxAttempts?: number;
	metrics?: MetricsRecorder;
}

/**
 * Production composition root for the GitHub event application. Constructs the
 * issue/comment/refinement/PR-review/auto-rebase/resume commands, the event
 * dispatcher, and a {@link GitHubIssueHandlers} wired to dispatch events
 * through them. GitHub/Octokit construction stays in the caller (the runtime
 * composition root); this factory only composes application-layer commands.
 */
export function createGitHubEventApplication(
	deps: GitHubEventApplicationDeps,
): GitHubIssueHandlers {
	const sessions = deps.sessions;
	const workspaces = deps.workspaces;
	const executor = deps.executor;
	const tasks = deps.tasks;
	const github = deps.github;
	const clock = deps.clock ?? systemClock;

	const refinementStore = deps.refinementStore;
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
		executor,
		clock,
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
		resolveIssueNewCommentEnabled: deps.resolveIssueNewCommentEnabled,
		resolveIssueAdminLinkInCommentsEnabled: deps.resolveIssueAdminLinkInCommentsEnabled,
		metrics: deps.metrics,
	});

	const execDeps = {
		sessions,
		workspaces,
		executor,
		github,
		tasks,
		clock,
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

	const handleIssueEventCmd = new HandleIssueEvent({
		sessions,
		workspaces,
		tasks,
		github,
		clock,
		defaultBranch: deps.defaultBranch,
		resolveDefaultBranch: deps.resolveDefaultBranch,
		githubUsername: deps.githubUsername,
		selfReportEnabled: deps.selfReportEnabled,
		executor: execDeps,
		refinement,
		issueAdminLinkInCommentsEnabled: deps.issueAdminLinkInCommentsEnabled,
		adminBaseUrl: deps.adminBaseUrl,
		resolveAdminBaseUrl: deps.resolveAdminBaseUrl,
		resolveIssueAdminLinkInCommentsEnabled: deps.resolveIssueAdminLinkInCommentsEnabled,
	});

	const handlePRReviewCmd = new HandlePRReview({
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

	const handleIssueCommentCmd = new HandleIssueComment({
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
		prReview: handlePRReviewCmd,
		fixMergeConflicts: fixMergeConflictsCmd,
		issueAdminLinkInCommentsEnabled: deps.issueAdminLinkInCommentsEnabled,
		adminBaseUrl: deps.adminBaseUrl,
		resolveAdminBaseUrl: deps.resolveAdminBaseUrl,
		resolveIssueAdminLinkInCommentsEnabled: deps.resolveIssueAdminLinkInCommentsEnabled,
	});

	const resumeSessionCmd = new ResumeInterruptedSession({
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

	const dispatcher = new GitHubEventDispatcher({
		handleIssueEvent: handleIssueEventCmd,
		handleIssueComment: handleIssueCommentCmd,
		handlePRReview: handlePRReviewCmd,
		handleAutoRebase: autoRebaseCmd,
		eventStore: deps.eventStore,
		githubUsername: deps.githubUsername,
	});

	return new GitHubIssueHandlers({
		dispatcher,
		resumeSession: resumeSessionCmd,
		restartRefinement: refinement,
		isInFlight: (owner, repo, issueNumber) =>
			handleIssueEventCmd.isInFlight(owner, repo, issueNumber),
		resolveGitHubEventMode: deps.resolveGitHubEventMode,
	});
}
