import React, { useMemo } from "react";
import type { AgentStatus, RepoSummary, Session } from "../../app/types.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatRelative } from "../../lib/format.js";

function sessionKey(session: Session): string {
	return `${session.owner}/${session.repo}#${session.issueNumber}`;
}

export function DashboardScreen({
	agentStatus,
	uptime,
	draining,
	repos,
	sessions,
	onSelectWorking,
	onSelectRepos,
	onNewIssue,
	onSelectSession,
}: {
	agentStatus: AgentStatus;
	uptime: string;
	draining: boolean;
	repos: RepoSummary[];
	sessions: Session[];
	onSelectWorking: () => void;
	onSelectRepos: () => void;
	onNewIssue: () => void;
	onSelectSession: (session: Session) => void;
}): React.ReactElement {
	const feedbackCount = sessions.filter(
		(s) => s.status === "waiting-feedback",
	).length;
	const workingCount = sessions.filter(
		(s) => s.status === "working",
	).length;

	const recentIssues = useMemo(() => {
		const byIssue = new Map<string, Session[]>();
		for (const s of sessions) {
			const key = sessionKey(s);
			const existing = byIssue.get(key);
			if (existing) {
				existing.push(s);
			} else {
				byIssue.set(key, [s]);
			}
		}

		const aggregates = Array.from(byIssue.values()).map((list) => {
			const mostRecent = list.sort(
				(a, b) =>
					new Date(b.lastActivity).getTime() -
					new Date(a.lastActivity).getTime(),
			)[0];
			return mostRecent;
		});

		return aggregates
			.sort(
				(a, b) =>
					new Date(b.lastActivity).getTime() -
					new Date(a.lastActivity).getTime(),
			)
			.slice(0, 10);
	}, [sessions]);

	return (
		<div className="dashboard">
			<div className="dashboard-stats">
				<div className="stat-card">
					<div className="stat-label">Agent</div>
					<div className="stat-value">
						<StatusBadge status={agentStatus} />
					</div>
				</div>
				<div className="stat-card">
					<div className="stat-label">Active Work</div>
					<div className="stat-value">{workingCount}</div>
				</div>
				<div className="stat-card">
					<div className="stat-label">Waiting Feedback</div>
					<div className="stat-value">{feedbackCount}</div>
				</div>
				<div className="stat-card">
					<div className="stat-label">Uptime</div>
					<div className="stat-value">{uptime}</div>
				</div>
				<div className="stat-card">
					<div className="stat-label">Repositories</div>
					<div className="stat-value">{repos.length}</div>
				</div>
				{draining && (
					<div className="stat-card draining">
						<div className="stat-label">State</div>
						<div className="stat-value">Draining</div>
					</div>
				)}
			</div>

			<div className="dashboard-section">
				<h2>Quick Links</h2>
				<div className="quick-link-grid">
					<button
						className="quick-link"
						onClick={onSelectWorking}
						type="button"
					>
						<span className="quick-link-icon">▶</span>
						<span className="quick-link-label">
							Active Issues
						</span>
					</button>
					<button
						className="quick-link"
						onClick={onSelectRepos}
						type="button"
					>
						<span className="quick-link-icon">📁</span>
						<span className="quick-link-label">
							Repositories
						</span>
					</button>
					<button
						className="quick-link"
						onClick={onNewIssue}
						type="button"
					>
						<span className="quick-link-icon">+</span>
						<span className="quick-link-label">New Issue</span>
					</button>
				</div>
			</div>

			<div className="dashboard-section">
				<h2>Recent Activity</h2>
				{recentIssues.length === 0 ? (
					<div className="empty-state">
						<p>No recent issues.</p>
					</div>
				) : (
					<div className="activity-list">
						<div className="activity-list-header">
							<div className="activity-repo">Repo</div>
							<div className="activity-issue">Issue</div>
							<div className="activity-status">Status</div>
							<div className="activity-time">Activity</div>
						</div>
						{recentIssues.map((session) => (
							<div
								key={sessionKey(session)}
								className="activity-row"
								onClick={() => onSelectSession(session)}
								tabIndex={0}
								role="button"
								onKeyDown={(e) => {
									if (
										e.key === "Enter" ||
										e.key === " "
									) {
										e.preventDefault();
										onSelectSession(session);
									}
								}}
							>
								<div className="activity-repo">
									{session.owner}/{session.repo}
								</div>
								<div className="activity-issue">
									{session.sessionType === "cron"
										? "–"
										: `#${session.issueNumber}`}
								</div>
								<div
									className={`activity-status ${session.status}`}
								>
									{session.status}
								</div>
								<div className="activity-time">
									{formatRelative(session.lastActivity)}
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
