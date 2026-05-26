import React, { useMemo, useState } from "react";
import { formatDuration, formatRelative } from "../../lib/format.js";
import type { Session } from "../../app/types.js";
import { isInProgressStatus } from "../../lib/status-helpers.js";

export function ActiveSessionsPanel({
	sessions,
	onSelectSession,
}: {
	sessions: Session[];
	onSelectSession: (session: Session) => void;
}): React.ReactElement {
	const [query, setQuery] = useState("");
	const [statusFilter, setStatusFilter] = useState<string>("all");

	const filtered = useMemo(() => {
		let list = sessions.filter((s) => isInProgressStatus(s.status));
		if (statusFilter !== "all") {
			list = list.filter((s) => s.status === statusFilter);
		}
		if (query.trim()) {
			const q = query.toLowerCase();
			list = list.filter(
				(s) =>
					s.owner.toLowerCase().includes(q) ||
					s.repo.toLowerCase().includes(q) ||
					String(s.issueNumber).includes(q) ||
					s.status.toLowerCase().includes(q),
			);
		}
		return list;
	}, [sessions, query, statusFilter]);

	return (
		<div className="active-sessions-panel">
			<div className="active-sessions-header">
				<h2>Active Sessions</h2>
				<div className="active-sessions-filters">
					<input
						type="text"
						placeholder="Filter by repo, issue, or status…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						className="filter-input"
					/>
					<select
						value={statusFilter}
						onChange={(e) => setStatusFilter(e.target.value)}
						className="filter-select"
					>
						<option value="all">All statuses</option>
						<option value="working">Working</option>
						<option value="pending">Pending</option>
						<option value="waiting-feedback">Waiting Feedback</option>
						<option value="paused">Paused</option>
					</select>
				</div>
			</div>
			{filtered.length === 0 ? (
				<div className="empty-state">
					<p>No active sessions.</p>
				</div>
			) : (
				<div className="active-sessions-list">
					<div className="active-sessions-list-header">
						<div className="list-col repo">Repo</div>
						<div className="list-col issue">Issue</div>
						<div className="list-col status">Status</div>
						<div className="list-col duration">Duration</div>
						<div className="list-col activity">Last Activity</div>
					</div>
					<div className="active-sessions-list-body">
						{filtered.map((session) => (
							<div
								key={`${session.owner}/${session.repo}#${session.issueNumber}`}
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
								<div className="activity-repo">
									{session.owner}/{session.repo}
								</div>
								<div className="activity-issue">
									{session.sessionType === "cron" ? "–" : `#${session.issueNumber}`}
								</div>
								<div className={`activity-status ${session.status}`}>
									{session.status}
								</div>
								<div className="activity-duration">
									{session.createdAt ? formatDuration(session.createdAt) : "–"}
								</div>
								<div className="activity-time">
									{formatRelative(session.lastActivity)}
								</div>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
