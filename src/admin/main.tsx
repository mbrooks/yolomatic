import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

type AgentStatus = "online" | "busy" | "feedback" | "offline";
type SessionStatus = "pending" | "working" | "waiting-feedback" | "complete" | "failed" | "cancelled";

const TERMINAL_STATUSES: readonly SessionStatus[] = ["complete", "failed", "cancelled"];

function isTerminalStatus(status: SessionStatus): boolean {
	return TERMINAL_STATUSES.includes(status);
}

type Session = {
	owner: string;
	repo: string;
	issueNumber: number;
	status: SessionStatus;
	workspacePath: string;
	branch: string;
	lastActivity: string;
	prUrl: string | null;
	prNumber: number | null;
	risk: {
		suspectedMisroute: boolean;
		reasons: string[];
		referencedIssueNumber: number | null;
	};
};

type StatusResponse = {
	agent: Exclude<AgentStatus, "offline">;
	uptime: string;
	sessions: Session[];
};

type LoadState =
	| { status: "loading"; data: null; error: null; updatedAt: null }
	| { status: "ready"; data: StatusResponse; error: null; updatedAt: Date }
	| { status: "error"; data: null; error: string; updatedAt: null };

const initialState: LoadState = { status: "loading", data: null, error: null, updatedAt: null };

function formatRelative(iso: string): string {
	const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function labelAgentStatus(status: AgentStatus): string {
	if (status === "online") return "Online";
	if (status === "busy") return "Busy";
	if (status === "feedback") return "Feedback";
	return "Offline";
}

function useStatus(refreshToken = 0): LoadState {
	const [state, setState] = useState<LoadState>(initialState);

	useEffect(() => {
		let cancelled = false;

		async function load(): Promise<void> {
			try {
				const response = await fetch("/api/status");
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}`);
				}
				const data = (await response.json()) as StatusResponse;
				if (!cancelled) {
					setState({ status: "ready", data, error: null, updatedAt: new Date() });
				}
			} catch (error) {
				if (!cancelled) {
					const message = error instanceof Error ? error.message : String(error);
					setState({ status: "error", data: null, error: message, updatedAt: null });
				}
			}
		}

		void load();
		const interval = window.setInterval(() => void load(), 5000);
		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	}, [refreshToken]);

	return state;
}

function StatusBadge({ status }: { status: AgentStatus }): React.ReactElement {
	return <span className={`badge ${status}`}>{labelAgentStatus(status)}</span>;
}

function StopButton({ owner, repo, issueNumber }: { owner: string; repo: string; issueNumber: number }): React.ReactElement {
	const [stopping, setStopping] = useState(false);
	const [result, setResult] = useState<string | null>(null);

	const handleStop = useCallback(async () => {
		if (!window.confirm(`Stop TARS on ${owner}/${repo}#${issueNumber}?`)) return;
		setStopping(true);
		setResult(null);
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}/cancel`, {
				method: "POST",
			});
			const data = (await response.json()) as { message?: string; error?: string };
			if (response.ok) {
				setResult(data.message ?? "Stopped.");
			} else {
				setResult(`Error: ${data.error ?? response.statusText}`);
			}
		} catch (error) {
			setResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setStopping(false);
		}
	}, [owner, repo, issueNumber]);

	return (
		<div className="stop-cell">
			<button type="button" className="stop-btn" onClick={handleStop} disabled={stopping}>
				{stopping ? "Stopping…" : "Stop"}
			</button>
			{result && <span className="stop-result">{result}</span>}
		</div>
	);
}

function DeleteButton({ owner, repo, issueNumber, onDeleted }: { owner: string; repo: string; issueNumber: number; onDeleted?: () => void }): React.ReactElement {
	const [deleting, setDeleting] = useState(false);
	const [result, setResult] = useState<string | null>(null);

	const handleDelete = useCallback(async () => {
		if (!window.confirm(`Delete session and workspace for ${owner}/${repo}#${issueNumber}? This cannot be undone.`)) return;
		setDeleting(true);
		setResult(null);
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}/delete`, {
				method: "POST",
			});
			const data = (await response.json()) as { message?: string; error?: string };
			if (response.ok) {
				setResult(data.message ?? "Deleted.");
				onDeleted?.();
			} else {
				setResult(`Error: ${data.error ?? response.statusText}`);
			}
		} catch (error) {
			setResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setDeleting(false);
		}
	}, [owner, repo, issueNumber, onDeleted]);

	return (
		<div className="stop-cell">
			<button type="button" className="delete-btn" onClick={handleDelete} disabled={deleting}>
				{deleting ? "Deleting…" : "Delete"}
			</button>
			{result && <span className="stop-result">{result}</span>}
		</div>
	);
}

function MarkFailedButton({ owner, repo, issueNumber, onMarked }: { owner: string; repo: string; issueNumber: number; onMarked?: () => void }): React.ReactElement {
	const [marking, setMarking] = useState(false);
	const [result, setResult] = useState<string | null>(null);

	const handleMarkFailed = useCallback(async () => {
		if (!window.confirm(`Mark ${owner}/${repo}#${issueNumber} failed?`)) return;
		setMarking(true);
		setResult(null);
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}/mark-failed`, {
				method: "POST",
			});
			const data = (await response.json()) as { message?: string; error?: string };
			if (response.ok) {
				setResult(data.message ?? "Marked failed.");
				onMarked?.();
			} else {
				setResult(`Error: ${data.error ?? response.statusText}`);
			}
		} catch (error) {
			setResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setMarking(false);
		}
	}, [owner, repo, issueNumber, onMarked]);

	return (
		<div className="stop-cell">
			<button type="button" className="warn-btn" onClick={handleMarkFailed} disabled={marking}>
				{marking ? "Marking…" : "Mark failed"}
			</button>
			{result && <span className="stop-result">{result}</span>}
		</div>
	);
}

function BulkDeleteButton({ count, onDeleted }: { count: number; onDeleted?: () => void }): React.ReactElement {
	const [deleting, setDeleting] = useState(false);
	const [result, setResult] = useState<string | null>(null);

	const handleDelete = useCallback(async () => {
		if (!window.confirm(`Delete all ${count} terminal sessions and their workspaces? This cannot be undone.`)) return;
		setDeleting(true);
		setResult(null);
		try {
			const response = await fetch("/api/sessions/delete-completed", {
				method: "POST",
			});
			const data = (await response.json()) as { deleted?: number; error?: string };
			if (response.ok) {
				setResult(`${data.deleted ?? 0} deleted.`);
				onDeleted?.();
			} else {
				setResult(`Error: ${data.error ?? response.statusText}`);
			}
		} catch (error) {
			setResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setDeleting(false);
		}
	}, [count, onDeleted]);

	return (
		<div className="stop-cell">
			<button type="button" className="delete-btn bulk" onClick={handleDelete} disabled={deleting}>
				{deleting ? "Deleting…" : `Delete all completed (${count})`}
			</button>
			{result && <span className="stop-result">{result}</span>}
		</div>
	);
}

function SessionRisk({ session }: { session: Session }): React.ReactElement {
	if (!session.risk.suspectedMisroute) {
		return <span className="risk-ok">OK</span>;
	}

	return (
		<div className="risk-warning">
			<strong>Check mapping</strong>
			{session.risk.referencedIssueNumber && (
				<span> references #{session.risk.referencedIssueNumber}</span>
			)}
			<ul>
				{session.risk.reasons.map((reason) => (
					<li key={reason}>{reason}</li>
				))}
			</ul>
		</div>
	);
}

function RestartButton({ owner, repo, issueNumber, onRestarted }: { owner: string; repo: string; issueNumber: number; onRestarted?: () => void }): React.ReactElement {
	const [restarting, setRestarting] = useState(false);
	const [result, setResult] = useState<string | null>(null);

	const handleRestart = useCallback(async () => {
		if (!window.confirm(`This will reset the workspace and re-queue the session for ${owner}/${repo}#${issueNumber}. Proceed?`)) return;
		setRestarting(true);
		setResult(null);
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}/restart`, {
				method: "POST",
			});
			const data = (await response.json()) as { message?: string; error?: string };
			if (response.ok) {
				setResult(data.message ?? "Restarted.");
				onRestarted?.();
			} else {
				setResult(`Error: ${data.error ?? response.statusText}`);
			}
		} catch (error) {
			setResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setRestarting(false);
		}
	}, [owner, repo, issueNumber, onRestarted]);

	return (
		<div className="stop-cell">
			<button type="button" className="restart-btn" onClick={handleRestart} disabled={restarting}>
				{restarting ? "Restarting…" : "Restart"}
			</button>
			{result && <span className="stop-result">{result}</span>}
		</div>
	);
}

function SessionTable({ sessions, onMutate }: { sessions: Session[]; onMutate?: () => void }): React.ReactElement {
	if (sessions.length === 0) {
		return <div className="empty">No active sessions</div>;
	}

	return (
		<table>
			<thead>
				<tr>
					<th>Repo</th>
					<th>Issue</th>
					<th>Status</th>
					<th>Workspace</th>
					<th>Last Activity</th>
					<th>PR</th>
					<th>Risk</th>
					<th>Actions</th>
				</tr>
			</thead>
			<tbody>
				{sessions.map((session) => (
					<tr key={`${session.owner}/${session.repo}#${session.issueNumber}`}>
						<td>{session.owner}/{session.repo}</td>
						<td>
							<a
								href={`https://github.com/${session.owner}/${session.repo}/issues/${session.issueNumber}`}
								target="_blank"
								rel="noreferrer"
							>
								#{session.issueNumber}
							</a>
						</td>
						<td>
							<span className={`status-badge ${session.status}`}>{session.status}</span>
						</td>
						<td>{session.workspacePath}</td>
						<td>{formatRelative(session.lastActivity)}</td>
						<td>
							{session.prUrl && session.prNumber ? (
								<a href={session.prUrl} target="_blank" rel="noreferrer">
									#{session.prNumber}
								</a>
							) : (
								"-"
							)}
						</td>
						<td>
							<SessionRisk session={session} />
						</td>
						<td>
							{session.status === "working" ? (
								<StopButton
									owner={session.owner}
									repo={session.repo}
									issueNumber={session.issueNumber}
								/>
							) : session.risk.suspectedMisroute && session.status !== "failed" ? (
								<MarkFailedButton
									owner={session.owner}
									repo={session.repo}
									issueNumber={session.issueNumber}
									onMarked={onMutate}
								/>
							) : (session.status === "failed" || session.status === "cancelled") && !session.risk.suspectedMisroute ? (
								<div className="action-cell">
									<RestartButton
										owner={session.owner}
										repo={session.repo}
										issueNumber={session.issueNumber}
										onRestarted={onMutate}
									/>
									<DeleteButton
										owner={session.owner}
										repo={session.repo}
										issueNumber={session.issueNumber}
										onDeleted={onMutate}
									/>
								</div>
							) : isTerminalStatus(session.status) ? (
								<DeleteButton
									owner={session.owner}
									repo={session.repo}
									issueNumber={session.issueNumber}
									onDeleted={onMutate}
								/>
							) : (
								"-"
							)}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function App(): React.ReactElement {
	const [tick, setTick] = useState(0);
	const state = useStatus(tick);
	const agentStatus: AgentStatus = state.status === "ready" ? state.data.agent : "offline";
	const sessions = state.status === "ready" ? state.data.sessions : [];
	const terminalCount = sessions.filter((s) => isTerminalStatus(s.status)).length;
	const lastUpdated = useMemo(() => {
		if (state.status === "loading") return "Loading...";
		if (state.status === "error") return `Error: ${state.error}`;
		return `Last updated: ${state.updatedAt.toLocaleTimeString()}`;
	}, [state]);

	return (
		<>
			<header>
				<h1>TARS Admin</h1>
				<div className="header-actions">
					<StatusBadge status={agentStatus} />
					{terminalCount > 0 && (
						<BulkDeleteButton count={terminalCount} onDeleted={() => setTick((t) => t + 1)} />
					)}
				</div>
			</header>
			{state.status === "error" ? <div className="empty">Unable to reach API</div> : <SessionTable sessions={sessions} onMutate={() => setTick((t) => t + 1)} />}
			<div className="last-updated">{lastUpdated}</div>
		</>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing root element");
}

createRoot(root).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);
