import React, { useState, useMemo, useCallback } from "react";
import type { OpenIssue } from "../../api/issues.js";
import { assignIssue } from "../../api/issues.js";
import { useSessionLog } from "../../hooks/useSessionLog.js";
import { SessionLogPanel } from "../sessions/SessionLogPanel.js";
import { formatRelative } from "../../lib/format.js";
import type { Session } from "../../app/types.js";

export function IssueDetail({
	selected,
	owner,
	repo,
	sessions,
	onAssignSuccess,
	onSelectSession,
	onMutate,
}: {
	selected: OpenIssue | null;
	owner: string;
	repo: string;
	sessions: Session[];
	onAssignSuccess?: () => void;
	onSelectSession?: (session: Session) => void;
	onMutate?: () => void;
}): React.ReactElement {
	const [assigning, setAssigning] = useState(false);
	const [assignError, setAssignError] = useState<string | null>(null);

	const issueSessions = useMemo(() => {
		if (!selected) return [];
		return sessions
			.filter(
				(s) =>
					s.owner === owner &&
					s.repo === repo &&
					s.issueNumber === selected.number,
			)
			.sort(
				(a, b) =>
					new Date(b.lastActivity).getTime() -
					new Date(a.lastActivity).getTime(),
			);
	}, [sessions, selected, owner, repo]);

	const primarySession = issueSessions[0] ?? null;
	const [paused, setPaused] = useState(false);
	const logState = useSessionLog(primarySession, paused);

	const handleAssign = useCallback(async () => {
		if (!selected) return;
		setAssigning(true);
		setAssignError(null);
		try {
			await assignIssue(owner, repo, selected.number);
			onAssignSuccess?.();
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			setAssignError(message);
		} finally {
			setAssigning(false);
		}
	}, [selected, owner, repo, onAssignSuccess]);

	if (!selected) {
		return (
			<div className="detail-pane empty">
				Select an issue from the list to view details.
			</div>
		);
	}

	return (
		<div className="detail-pane">
			<div className="detail-title">
				<a href={selected.html_url} target="_blank" rel="noreferrer">
					#{selected.number} {selected.title}
				</a>
			</div>

			<div className="detail-section">
				<h3>Description</h3>
				{selected.body ? (
					<div className="issue-body">{selected.body}</div>
				) : (
					<div className="issue-body-empty">
						No description provided.
					</div>
				)}
			</div>

			<div className="detail-section">
				<h3>Assignees</h3>
				<div className="detail-row">
					{selected.assignees.length > 0 ? (
						selected.assignees.map((a) => (
							<span key={a} className="issue-tag assignee-tag">
								{a}
							</span>
						))
					) : (
						<span className="issue-body-empty">Unassigned</span>
					)}
					{selected.assignees.length === 0 && (
						<button
							className="action-btn"
							onClick={handleAssign}
							disabled={assigning}
							style={{ marginLeft: "0.5rem" }}
						>
							{assigning ? "Assigning..." : "Assign to TARS"}
						</button>
					)}
					{assignError && (
						<div
							className="form-error"
							style={{ marginTop: "0.25rem" }}
						>
							{assignError}
						</div>
					)}
				</div>
			</div>

			<div className="detail-section">
				<h3>Labels</h3>
				<div className="detail-row">
					{selected.labels.length > 0 ? (
						selected.labels.map((l) => (
							<span key={l} className="issue-tag label-tag">
								{l}
							</span>
						))
					) : (
						<span className="issue-body-empty">No labels</span>
					)}
				</div>
			</div>

			<div className="detail-section">
				<h3>TARS Session</h3>
				{primarySession ? (
					<>
						<dl className="detail-grid">
							<dt>Status</dt>
							<dd>
								<span
									className={`status-badge ${primarySession.status}`}
								>
									{primarySession.status}
								</span>
							</dd>
							<dt>Branch</dt>
							<dd>{primarySession.branch}</dd>
							<dt>Workspace</dt>
							<dd>{primarySession.workspacePath}</dd>
							<dt>Last activity</dt>
							<dd>
								{formatRelative(primarySession.lastActivity)}
							</dd>
							{primarySession.prUrl ? (
								<>
									<dt>Pull request</dt>
									<dd>
										<a
											href={primarySession.prUrl}
											target="_blank"
											rel="noreferrer"
										>
											PR #{primarySession.prNumber}
										</a>
									</dd>
								</>
							) : null}
						</dl>
						{onSelectSession && (
							<button
								className="action-btn"
								onClick={() => onSelectSession(primarySession)}
								style={{ marginTop: "0.5rem" }}
							>
								View Session
							</button>
						)}
					</>
				) : (
					<div className="issue-body-empty">
						No TARS session for this issue.
					</div>
				)}
			</div>

			{issueSessions.length > 1 && (
				<div className="detail-section">
					<h3>Session History</h3>
					{issueSessions.slice(1).map((s) => (
						<div
							key={`${s.owner}/${s.repo}#${s.issueNumber}-${s.lastActivity}`}
							className="detail-row"
							style={{ marginBottom: "0.25rem" }}
						>
							<span className={`status-badge ${s.status}`}>
								{s.status}
							</span>
							<span className="issue-label-summary">
								{formatRelative(s.lastActivity)}
							</span>
							{s.sessionType === "cron" && (
								<span className="type-badge cron">Cron</span>
							)}
						</div>
					))}
				</div>
			)}

			{primarySession && (
				<div className="detail-section">
					<h3>Log</h3>
					<SessionLogPanel
						state={logState}
						paused={paused}
						onPauseToggle={() => setPaused((p) => !p)}
					/>
				</div>
			)}
		</div>
	);
}
