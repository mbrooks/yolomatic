import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

type AgentStatus = "online" | "busy" | "feedback" | "offline";
type SessionStatus = "pending" | "working" | "waiting-feedback" | "complete" | "failed" | "cancelled";

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

function useStatus(): LoadState {
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
	}, []);

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

function SessionTable({ sessions }: { sessions: Session[] }): React.ReactElement {
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
							{session.status === "working" ? (
								<StopButton
									owner={session.owner}
									repo={session.repo}
									issueNumber={session.issueNumber}
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
	const state = useStatus();
	const agentStatus: AgentStatus = state.status === "ready" ? state.data.agent : "offline";
	const sessions = state.status === "ready" ? state.data.sessions : [];
	const lastUpdated = useMemo(() => {
		if (state.status === "loading") return "Loading...";
		if (state.status === "error") return `Error: ${state.error}`;
		return `Last updated: ${state.updatedAt.toLocaleTimeString()}`;
	}, [state]);

	return (
		<>
			<header>
				<h1>TARS Admin</h1>
				<StatusBadge status={agentStatus} />
			</header>
			{state.status === "error" ? <div className="empty">Unable to reach API</div> : <SessionTable sessions={sessions} />}
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
