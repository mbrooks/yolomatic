import type { Clock } from "../../ports/clock.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { StaleSessionService } from "../../ports/stale-session-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { SettingsStore } from "../../settings/store.js";
import {
	buildRepoSummaries,
	computeAgentStatus,
	detectSessionRisk,
	sessionKey,
	sortSessionsByRecency,
} from "../../domain/session/model.js";
import { formatUptime } from "../../domain/workflow/policy.js";
import { parseConfiguredRepositories } from "../../repos/configured-repositories.js";
import type { StaleSessionInfo } from "../../session/stale-detector.js";
import { ok, type AppResult } from "../result.js";

export interface AdminStatusSessionView {
	owner: string;
	repo: string;
	issueNumber: number;
	status: string;
	title: string | null;
	body: string | null;
	summary: string | null;
	workspacePath: string;
	branch: string;
	lastActivity: string;
	createdAt: string | null;
	prUrl: string | null;
	prNumber: number | null;
	risk: ReturnType<typeof detectSessionRisk>;
	staleDetectedAt: string | null;
	staleReason: string | null;
	stale: {
		isStale: boolean;
		ageMinutes: number;
		classification: string;
		worktreeDirty: boolean | null;
		issueState: string | null;
		prState: string | null;
	} | null;
	taskStartedAt: string | null;
	taskFinishedAt: string | null;
	totalExecutionTimeMs: number | null;
}

export interface AdminStatusView {
	agent: "online" | "busy" | "feedback";
	uptime: string;
	draining: boolean;
	repos: ReturnType<typeof buildRepoSummaries>;
	sessions: AdminStatusSessionView[];
}

export class GetAdminStatus {
	constructor(
		private readonly sessions: SessionRepository,
		private readonly stale: StaleSessionService,
		private readonly clock: Clock,
		private readonly taskControl: TaskControlService,
		private readonly settingsStore?: SettingsStore,
	) {}

	async execute(): Promise<AppResult<AdminStatusView>> {
		const all = await this.sessions.getAll();
		const sorted = sortSessionsByRecency(all);
		const staleMap = new Map<string, StaleSessionInfo>();

		try {
			const staleInfos = await this.stale.detectStaleSessions();
			for (const info of staleInfos) {
				staleMap.set(sessionKey(info.session.owner, info.session.repo, info.session.issueNumber), info);
			}
		} catch {
			// ignore stale detection errors
		}

		let repos = buildRepoSummaries(sorted);

		if (this.settingsStore) {
			const repoMap = new Map(repos.map((r) => [`${r.owner}/${r.repo}`.toLowerCase(), r]));
			for (const configured of parseConfiguredRepositories(this.settingsStore.get("configured_repositories"))) {
				const key = `${configured.owner}/${configured.repo}`.toLowerCase();
				if (repoMap.has(key)) {
					continue;
				}
				repoMap.set(key, {
					owner: configured.owner,
					repo: configured.repo,
					sessionCount: 0,
					activeCount: 0,
					lastActivity: null,
				});
			}
			repos = Array.from(repoMap.values()).sort((a, b) => {
				if (a.owner !== b.owner) return a.owner.localeCompare(b.owner);
				return a.repo.localeCompare(b.repo);
			});
		}

		const view: AdminStatusView = {
			agent: computeAgentStatus(sorted),
			uptime: formatUptime(this.clock.uptime()),
			draining: this.taskControl.isDraining(),
			repos,
			sessions: sorted.map((s) => {
				const stale = staleMap.get(sessionKey(s.owner, s.repo, s.issueNumber));
				return {
					owner: s.owner,
					repo: s.repo,
					issueNumber: s.issueNumber,
					status: s.status,
					title: s.title ?? null,
					body: s.body ?? null,
					summary: s.summary ?? null,
					workspacePath: s.workspacePath,
					branch: s.branch ?? `tars/issue-${s.issueNumber}`,
					lastActivity: s.lastActivity,
					createdAt: s.createdAt ?? null,
					prUrl: s.prUrl ?? null,
					prNumber: s.prNumber ?? null,
					risk: detectSessionRisk(s),
					staleDetectedAt: s.staleDetectedAt ?? null,
					staleReason: s.staleReason ?? null,
					stale: stale
						? {
								isStale: stale.isStale,
								ageMinutes: Math.floor(stale.ageMs / 60000),
								classification: stale.classification,
								worktreeDirty: stale.worktreeDirty,
								issueState: stale.issueState ?? null,
								prState: stale.prState ?? null,
							}
						: null,
					taskStartedAt: s.taskStartedAt ?? null,
					taskFinishedAt: s.taskFinishedAt ?? null,
					totalExecutionTimeMs: s.totalExecutionTimeMs ?? null,
				};
			}),
		};

		return ok(view);
	}
}
