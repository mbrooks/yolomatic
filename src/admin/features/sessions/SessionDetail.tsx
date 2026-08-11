import React, { useState } from "react";
import { ActionButton, useAction } from "../../components/ActionButton.js";
import { SESSION_ACTIONS, sendSessionCommand, type SessionActionConfig } from "../../api/sessions.js";
import { useSessionLog } from "../../hooks/useSessionLog.js";
import { formatRelative, formatMs } from "../../lib/format.js";
import type { Session } from "../../app/types.js";
import { SessionLogPanel } from "./SessionLogPanel.js";

export function SessionDetail({
	selected,
	onMutate,
	activeTab,
	onDeselect,
}: {
	selected: Session | null;
	onMutate: () => void;
	activeTab?: "sessions" | "skills" | "issues" | "settings";
	onDeselect?: () => void;
}): React.ReactElement {
	const [paused, setPaused] = useState(false);
	const logState = useSessionLog(selected, paused);

	if (!selected) {
		return (
			<div className="detail-pane empty">
				Select a session from the list to view details and actions.
			</div>
		);
	}

	return (
		<div className="detail-pane">
			{onDeselect ? (
				<button type="button" className="session-back" onClick={onDeselect}>
					← Back to sessions
				</button>
			) : null}
			<IssueSummaryBlock session={selected} />
			<div className="detail-title">
				{selected.owner}/{selected.repo}#{selected.issueNumber}
			</div>

			<div className="detail-section">
				<h3>Summary</h3>
				<dl className="detail-grid">
					<dt>Type</dt>
					<dd>
						<span className={`type-badge ${selected.kind}`}>
							{selected.kind === "refinement" ? "Refinement" : "Issue"}
						</span>
					</dd>
					<dt>Status</dt>
					<dd>
						<span className={`status-badge ${selected.status}`}>{selected.status}</span>
					</dd>
					{selected.kind === "implementation" ? (
						<>
							<dt>Branch</dt>
							<dd>{selected.branch}</dd>
							<dt>Workspace</dt>
							<dd>{selected.workspacePath}</dd>
						</>
					) : null}
					<dt>Last activity</dt>
					<dd>{formatRelative(selected.lastActivity)}</dd>
					{selected.totalExecutionTimeMs !== null ? (
						<>
							<dt>Total execution time</dt>
							<dd>{formatMs(selected.totalExecutionTimeMs)}</dd>
						</>
					) : null}
					{selected.taskStartedAt ? (
						<>
							<dt>Task started</dt>
							<dd>{formatRelative(selected.taskStartedAt)}</dd>
						</>
					) : null}
					{selected.taskFinishedAt ? (
						<>
							<dt>Task finished</dt>
							<dd>{formatRelative(selected.taskFinishedAt)}</dd>
						</>
					) : null}
					<>
						<dt>Issue</dt>
						<dd>
							<a
								href={`https://github.com/${selected.owner}/${selected.repo}/issues/${selected.issueNumber}`}
								target="_blank"
								rel="noreferrer"
							>
								#{selected.issueNumber}
							</a>
						</dd>
						{selected.kind === "implementation" ? (
							<>
								<dt>Pull request</dt>
								<dd>
									{selected.prUrl ? (
										<a href={selected.prUrl} target="_blank" rel="noreferrer">
											PR #{selected.prNumber ?? "open"}
										</a>
									) : (
										"None"
									)}
								</dd>
							</>
						) : null}
					</>
				</dl>
			</div>

			<div className="detail-section">
				<h3>Risk</h3>
				{selected.risk.suspectedMisroute ? (
					<div className="risk-warning">
						<div>Potential misroute detected.</div>
						<ul>
							{selected.risk.reasons.map((reason) => (
								<li key={reason}>{reason}</li>
							))}
						</ul>
					</div>
				) : (
					<div className="risk-ok">No routing risk detected.</div>
				)}
			</div>

			{selected.stale ? (
				<div className="detail-section">
					<h3>Staleness</h3>
					<div className="detail-row">
						<span className="stale-badge">
							{selected.stale.classification} · {selected.stale.ageMinutes}m old
						</span>
					</div>
				</div>
			) : null}

			{selected.kind === "implementation" ? (
				<div className="detail-section">
					<h3>Actions</h3>
					<div className="detail-actions">
						{SESSION_ACTIONS.filter((action) => action.visible(selected.status)).map((action) => (
							<SessionActionControl
								key={action.key}
								session={selected}
								action={action}
								onMutate={onMutate}
							/>
						))}
					</div>
				</div>
			) : null}

			<div className="detail-section">
				<h3>Log</h3>
				<SessionLogPanel
					state={logState}
					paused={paused}
					onPauseToggle={() => setPaused((current) => !current)}
				/>
			</div>
		</div>
	);
}

function IssueSummaryBlock({ session }: { session: Session }): React.ReactElement | null {
	const issueUrl = `https://github.com/${session.owner}/${session.repo}/issues/${session.issueNumber}`;
	const hasTitle = session.title !== null && session.title.trim() !== "";
	const excerptBase = session.summary ?? session.body ?? "";
	const hasExcerpt = excerptBase.trim() !== "";
	const MAX_EXCERPT = 300;
	const truncated = excerptBase.length > MAX_EXCERPT;
	const excerpt = truncated ? `${excerptBase.slice(0, MAX_EXCERPT).trimEnd()}…` : excerptBase;

	if (!hasTitle && !hasExcerpt) {
		return (
			<div className="detail-section issue-summary">
				<h3>Issue summary</h3>
				<div className="issue-summary-empty">No issue description available.</div>
			</div>
		);
	}

	return (
		<div className="detail-section issue-summary">
			<h3>Issue summary</h3>
			{hasTitle ? (
				<a className="issue-summary-title" href={issueUrl} target="_blank" rel="noreferrer">
					#{session.issueNumber} {session.title}
				</a>
			) : (
				<a className="issue-summary-title" href={issueUrl} target="_blank" rel="noreferrer">
					#{session.issueNumber}
				</a>
			)}
			{hasExcerpt ? (
				<div className="issue-summary-body">
					{excerpt}{" "}
					{truncated ? (
						<a href={issueUrl} target="_blank" rel="noreferrer">more</a>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function SessionActionControl({
	session,
	action,
	onMutate,
}: {
	session: Session;
	action: SessionActionConfig;
	onMutate: () => void;
}): React.ReactElement {
	const { loading, result, execute } = useAction(async () => {
		const ok = window.confirm(action.confirmMessage(session));
		if (!ok) {
			return { ok: true, message: "Cancelled." };
		}
		const response = await sendSessionCommand(
			session.owner,
				session.repo,
				session.issueNumber,
				session.kind,
				action.command(session),
		);
		if (response.ok) {
			onMutate();
		}
		return response;
	});

	return (
		<ActionButton
			label={action.label}
			loadingLabel={action.loadingLabel}
			variant={action.variant}
			onClick={() => execute()}
			disabled={loading}
			result={result}
		/>
	);
}
