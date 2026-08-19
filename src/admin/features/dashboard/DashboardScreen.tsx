import React from "react";
import type { AgentStatus, MetricsResponse, RepoSummary, Session } from "../../app/types.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { MetricsSection } from "./MetricsSection.js";
import { formatRelative } from "../../lib/format.js";
import { buildRecentActivity, type ActivityItem } from "./recent-activity.js";

export function DashboardScreen({
	agentStatus,
	uptime,
	draining,
	repos,
	sessions,
	metrics,
	onSelectWorking,
	onSelectRepos,
	onSelectSession,
}: {
	agentStatus: AgentStatus;
	uptime: string;
	draining: boolean;
	repos: RepoSummary[];
	sessions: Session[];
	metrics: MetricsResponse | null;
	onSelectWorking: () => void;
	onSelectRepos: () => void;
	onSelectSession: (session: Session) => void;
}): React.ReactElement {
	const feedbackCount = sessions.filter((s) => s.status === "waiting-feedback").length;
	const workingCount = sessions.filter((s) => s.status === "working").length;

	const recentSessions = buildRecentActivity(sessions, metrics?.recent ?? []);

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
					<button className="quick-link" onClick={onSelectWorking} type="button">
						<span className="quick-link-icon">▶</span>
						<span className="quick-link-label">Active Sessions</span>
					</button>
					<button className="quick-link" onClick={onSelectRepos} type="button">
						<span className="quick-link-icon">📁</span>
						<span className="quick-link-label">Repositories</span>
					</button>
				</div>
			</div>

			<MetricsSection metrics={metrics} />

			<div className="dashboard-section">
				<h2>Recent Activity</h2>
				{recentSessions.length === 0 ? (
					<div className="empty-state">
						<p>No recent sessions.</p>
					</div>
				) : (
					<div className="activity-list">
						<div className="activity-list-header">
							<div className="activity-repo">Repo</div>
							<div className="activity-issue">Issue</div>
							<div className="activity-type">Type</div>
							<div className="activity-status">Status</div>
							<div className="activity-time">Activity</div>
						</div>
						{recentSessions.map((item) => {
							const isRefinement = item.kind === "refinement";
							const key = `${item.owner}/${item.repo}#${item.issueNumber}/${item.kind}`;
							if (item.session) {
								const session = item.session;
								return (
									<div
										key={key}
										className="activity-row"
										onClick={() => onSelectSession(session)}
										tabIndex={0}
										role="button"
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												onSelectSession(session);
											}
										}}
									>
										<ActivityCells item={item} isRefinement={isRefinement} />
									</div>
								);
							}
							return (
								<div key={key} className="activity-row activity-row-static" aria-disabled="true">
									<ActivityCells item={item} isRefinement={isRefinement} />
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}

function ActivityCells({
	item,
	isRefinement,
}: {
	item: ActivityItem;
	isRefinement: boolean;
}): React.ReactElement {
	return (
		<>
			<div className="activity-repo">
				{item.owner}/{item.repo}
			</div>
			<div className="activity-issue">#{item.issueNumber}</div>
			<div className="activity-type">
				<span className={`type-badge ${isRefinement ? "refinement" : "implementation"}`}>
					{isRefinement ? "Refinement" : "Issue"}
				</span>
			</div>
			<div className={`activity-status ${item.status}`}>
				<span className={`status-badge ${item.status}`}>{item.status}</span>
			</div>
			<div className="activity-time">{formatRelative(item.activity)}</div>
		</>
	);
}