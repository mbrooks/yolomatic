import { Octokit } from "@octokit/rest";

import type { SessionState, SessionStore } from "./store.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import { createOctokit } from "../adapters/github/octokit.js";

export type StaleClassification =
	| "stale-complete-candidate"
	| "stale-abandoned-candidate"
	| "needs-review"
	| "safe-to-archive"
	| "unknown";

export interface StaleSessionInfo {
	session: SessionState;
	isStale: boolean;
	ageMs: number;
	classification: StaleClassification;
	worktreeDirty: boolean | null;
	issueState?: string;
	prState?: string;
}

export class StaleSessionDetector {
	private readonly octokit: Octokit;

	public constructor(
		private readonly sessionStore: SessionStore,
		private readonly workspaceManager: WorkspaceManager,
		githubToken: string,
		private readonly isInFlight: (owner: string, repo: string, issueNumber: number) => boolean,
		private readonly thresholdMs: number,
	) {
		this.octokit = createOctokit(githubToken);
	}

	async detectStaleSessions(): Promise<StaleSessionInfo[]> {
		const sessions = await this.sessionStore.getAll();
		const staleInfos: StaleSessionInfo[] = [];

		for (const session of sessions) {
			const info = await this.evaluateSession(session);
			staleInfos.push(info);
		}

		return staleInfos;
	}

	async evaluateSession(session: SessionState): Promise<StaleSessionInfo> {
		const now = Date.now();
		const lastActivity = new Date(session.lastActivity).getTime();
		const ageMs = now - lastActivity;

		if (session.sessionType === "cron") {
			return {
				session,
				isStale: false,
				ageMs,
				classification: "unknown",
				worktreeDirty: null,
			};
		}

		if (session.status !== "working") {
			return {
				session,
				isStale: false,
				ageMs,
				classification: "unknown",
				worktreeDirty: null,
			};
		}

		if (this.isInFlight(session.owner, session.repo, session.issueNumber)) {
			return {
				session,
				isStale: false,
				ageMs,
				classification: "unknown",
				worktreeDirty: null,
			};
		}

		const isStale = ageMs > this.thresholdMs;
		let worktreeDirty: boolean | null = null;
		try {
			worktreeDirty = await this.workspaceManager.hasChanges(session.workspacePath, false);
		} catch {
			worktreeDirty = null;
		}

		if (!isStale) {
			return {
				session,
				isStale: false,
				ageMs,
				classification: "unknown",
				worktreeDirty,
			};
		}

		const classification = await this.classifyStaleSession(session, worktreeDirty);

		return {
			session,
			isStale: true,
			ageMs,
			classification: classification.classification,
			worktreeDirty,
			issueState: classification.issueState,
			prState: classification.prState,
		};
	}

	private async classifyStaleSession(
		session: SessionState,
		worktreeDirty: boolean | null,
	): Promise<{ classification: StaleClassification; issueState?: string; prState?: string }> {
		let issueState: string | undefined;
		let prState: string | undefined;

		try {
			const { data: issue } = await this.octokit.issues.get({
				owner: session.owner,
				repo: session.repo,
				issue_number: session.issueNumber,
			});
			issueState = issue.state;
		} catch {
			issueState = "missing";
		}

		if (session.prNumber) {
			try {
				const { data: pr } = await this.octokit.pulls.get({
					owner: session.owner,
					repo: session.repo,
					pull_number: session.prNumber,
				});
				prState = pr.merged ? "merged" : pr.state;
			} catch {
				prState = "missing";
			}
		}

		if (issueState === "closed" && prState === "merged") {
			return { classification: "stale-complete-candidate", issueState, prState };
		}

		if ((issueState === "missing" || issueState === "closed") && prState === "closed") {
			return { classification: "stale-abandoned-candidate", issueState, prState };
		}

		if (worktreeDirty) {
			return { classification: "needs-review", issueState, prState };
		}

		if (worktreeDirty === false && (issueState === "missing" || issueState === "closed")) {
			return { classification: "safe-to-archive", issueState, prState };
		}

		return { classification: "unknown", issueState, prState };
	}
}
