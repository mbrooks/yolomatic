import React from "react";
import { Breadcrumb } from "../../components/Breadcrumb.js";
import { EmptyState } from "../../components/EmptyState.js";
import { ActionButton, useAction } from "../../components/ActionButton.js";
import { SESSION_ACTIONS, sendSessionCommand, type SessionActionConfig } from "../../api/sessions.js";
import { useSessionLog } from "../../hooks/useSessionLog.js";
import { formatRelative } from "../../lib/format.js";
import type { Session } from "../../app/types.js";

export function SessionScreen({
	sessions,
	selected,
	onSelect,
	onMutate,
	breadcrumbLabel,
	onBack,
	emptyMessage,
	activeTab,
	onSelectTab,
}: {
	sessions: Session[];
	selected: Session | null;
	onSelect: (session: Session) => void;
	onMutate: () => void;
	breadcrumbLabel: string;
	onBack: () => void;
	emptyMessage: string;
	activeTab?: "sessions" | "crons";
	onSelectTab?: (tab: "sessions" | "crons") => void;
}): React.ReactElement {
	return (
		<>
			{onSelectTab && (
				<div className="repo-tabs">
					<button
						className={`repo-tab${activeTab === "sessions" ? " active" : ""}`}
						onClick={() => onSelectTab("sessions")}
						type="button"
						>
						Sessions
					</button>
					<button
						className={`repo-tab${activeTab === "crons" ? " active" : ""}`}
						onClick={() => onSelectTab("crons")}
						type="button"
						>
						Crons
					</button>
				</div>
			)}
			<Breadcrumb label={breadcrumbLabel} onBack={onBack} />
			{sessions.length === 0 ? (
				<EmptyState message={emptyMessage} />
			) : (
				<div className="workspace">
					<div className="list-pane">
						<div className="list-header">
							<div className="list-col repo">Repo</div>
							<div className="list-col issue">Issue</div>
							<div className="list-col status">Status</div>
							<div className="list-col activity">Activity</div>
						</div>
						<div className="list-body">
							{sessions.map((session) => {
								const isSelected =
									selected?.owner === session.owner &&
									selected?.repo === session.repo &&
									selected?.issueNumber === session.issueNumber;
								return (
									<div
										key={`${session.owner}/${session.repo}#${session.issueNumber}`}
										className={`list-row${isSelected ? " selected" : ""}`}
										onClick={() => onSelect(session)}
										tabIndex={0}
										role="button"
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												onSelect(session);
											}
										}}
									>
										<div className="list-col repo">
											{session.owner}/{session.repo}
										</div>
										<div className="list-col issue">#{session.issueNumber}</div>
										<div className="list-col status">
											<span className={`status-badge ${session.status}`}>{session.status}</span>
										</div>
										<div className="list-col activity">{formatRelative(session.lastActivity)}</div>
										{session.stale?.isStale ? <span className="stale-dot" aria-label="Stale session" /> : null}
									</div>
								);
							})}
						</div>
					</div>

					<SessionDetail selected={selected} onMutate={onMutate} />
				</div>
			)}
		</>
	);
}

function SessionDetail({
	selected,
	onMutate,
}: {
	selected: Session | null;
	onMutate: () => void;
}): React.ReactElement {
	const logState = useSessionLog(selected);

	if (!selected) {
		return (
			<div className="detail-pane empty">
				Select a session from the list to view details and actions.
			</div>
		);
	}

	return (
		<div className="detail-pane">
			<div className="detail-title">
				{selected.owner}/{selected.repo}#{selected.issueNumber}
			</div>

			<div className="detail-section">
				<h3>Summary</h3>
				<dl className="detail-grid">
					<dt>Status</dt>
					<dd>
						<span className={`status-badge ${selected.status}`}>{selected.status}</span>
					</dd>
					<dt>Branch</dt>
					<dd>{selected.branch}</dd>
					<dt>Workspace</dt>
					<dd>{selected.workspacePath}</dd>
					<dt>Last activity</dt>
					<dd>{formatRelative(selected.lastActivity)}</dd>
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

			<div className="detail-section">
				<h3>Log</h3>
				<SessionLogPanel state={logState} />
			</div>
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
		const response = await sendSessionCommand(session.owner, session.repo, session.issueNumber, action.command(session));
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

function SessionLogPanel({
	state,
}: {
	state: ReturnType<typeof useSessionLog>;
}): React.ReactElement {
	if (state.status === "idle") {
		return <div className="log-status">Select a session to load logs.</div>;
	}

	if (state.status === "loading") {
		return <div className="log-status">Loading log…</div>;
	}

	if (state.status === "error") {
		return <div className="log-status log-error">{state.error ?? "Unable to load log."}</div>;
	}

	const lines = state.data?.lines ?? [];
	const content = lines.length > 0 ? lines.join("\n") : "No log output yet.";

	return (
		<div className="log-container">
			{state.data?.truncated ? (
				<div className="log-truncation-notice">
					Log truncated to the most recent {state.data.totalLines ?? lines.length} lines.
				</div>
			) : null}
			{state.refreshing ? <div className="log-refresh-notice">Refreshing…</div> : null}
			<pre className="log-content">{content}</pre>
		</div>
	);
}
