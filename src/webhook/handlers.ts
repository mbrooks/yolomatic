import type { GitHubEvent } from "../github-events/model.js";
import {
	repoModeIncludesPolling,
	repoModeIncludesWebhook,
	type RepoGitHubEventMode,
} from "../repos/repository.js";

export interface WebhookHandlers {
	handleGitHubEvent?(event: GitHubEvent): Promise<void>;
	isInFlight(owner: string, repo: string, issueNumber: number): boolean;
}

/**
 * Narrow command set {@link GitHubIssueHandlers} dispatches to. The handlers
 * class no longer constructs application commands or a GitHub service adapter;
 * the composition root ({@link createGitHubEventApplication}) builds them and
 * injects this set. Each member is a typed external port so tests can inject
 * fakes without reaching into prototype mutation or full session/workspace
 * fixtures.
 */
export interface GitHubIssueHandlerCommands {
	/** Receives normalized GitHub events after repository event-mode gating. */
	dispatcher: { dispatch(event: GitHubEvent): Promise<void> };
	/** Resumes an interrupted implementation session for an issue. */
	resumeSession: { execute(owner: string, repo: string, issueNumber: number): Promise<void> };
	/** Restarts an interrupted refinement session for an issue. */
	restartRefinement: { restart(owner: string, repo: string, issueNumber: number): Promise<void> };
	/** Reports whether any command is actively executing for the issue. */
	isInFlight(owner: string, repo: string, issueNumber: number): boolean;
	/** Optional per-repo event-mode resolver used to filter webhook/polling events. */
	resolveGitHubEventMode?: (owner: string, repo: string) => RepoGitHubEventMode;
}

export class GitHubIssueHandlers implements WebhookHandlers {
	private readonly inFlight = new Set<string>();

	public constructor(private readonly deps: GitHubIssueHandlerCommands) {}

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
		await this.deps.dispatcher.dispatch(event);
	}

	async resumeInterruptedSession(owner: string, repo: string, issueNumber: number): Promise<void> {
		const key = `${owner}/${repo}#${issueNumber}`;
		this.inFlight.add(key);
		try {
			await this.deps.resumeSession.execute(owner, repo, issueNumber);
		} finally {
			this.inFlight.delete(key);
		}
	}

	async restartRefinement(owner: string, repo: string, issueNumber: number): Promise<void> {
		await this.deps.restartRefinement.restart(owner, repo, issueNumber);
	}

	isInFlight(owner: string, repo: string, issueNumber: number): boolean {
		const key = `${owner}/${repo}#${issueNumber}`;
		return this.inFlight.has(key) || this.deps.isInFlight(owner, repo, issueNumber);
	}
}