import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

type AgentStatus = "online" | "busy" | "feedback" | "offline";
type SessionStatus = "pending" | "working" | "waiting-feedback" | "complete" | "failed";
type StaleClassification =
	| "stale-complete-candidate"
	| "stale-abandoned-candidate"
	| "needs-review"
	| "safe-to-archive"
	| "unknown";

interface StaleInfo {
	isStale: boolean;
	ageMinutes: number;
	classification: StaleClassification;
	worktreeDirty: boolean | null;
	issueState: string | null;
	prState: string | null;
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
	staleDetectedAt: string | null;
	staleReason: string | null;
	stale: StaleInfo | null;
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

function formatDuration(minutes: number): string {
	if (minutes < 60) return `${minutes}m`;
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
	const d = Math.floor(h / 24);
	return `${d}d`;
}

function labelAgentStatus(status: AgentStatus): string {
	if (status === "online") return "Online";
	if (status === "busy") return "Busy";
	if (status === "feedback") return "Feedback";
	return "Offline";
}

function classificationLabel(c: StaleClassification): string {
	if (c === "stale-complete-candidate") return "complete candidate";
	if (c === "stale-abandoned-candidate") return "abandoned";
	if (c === "needs-review") return "needs review";
	if (c === "safe-to-archive") return "safe to archive";
	return c;
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

function AdminActions({ session }: { session: Session }): React.ReactElement {
	const [busy, setBusy] = useState<false | string>(false);
	const [error, setError] = useState<string | null>(null);

	async function postAction(path: string, body: object) {
		setBusy(path);
		setError(null);
		try {
			const res = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
				throw new Error(data.error ?? `HTTP ${res.status}`);
			}
			window.location.reload();
		} catch (err) {
			setBusy(false);
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	const key = `${session.owner}/${session.repo}#${session.issueNumber}`;

	return (
		<div className="actions">
			<button
				className="btn"
				disabled={!!busy}
				onClick={() =>
					postAction("/api/sessions/archive", {
						owner: session.owner,
						repo: session.repo,
						issueNumber: session.issueNumber,
					})
				}
				title="Archive session"
			>
				🗃️ Archive
			</button>
			<button
				className="btn btn-danger"
				disabled={!!busy}
				onClick={() =>
					postAction("/api/sessions/mark-failed", {
						owner: session.owner,
						repo: session.repo,
						issueNumber: session.issueNumber,
						reason: "stale_session_cleanup",
					})
				}
				title="Mark failed"
			>
				❌ Mark failed
			</button>
			<button
				className="btn btn-success"
				disabled={!!busy}
				onClick={() =>
					postAction("/api/sessions/mark-complete", {
						owner: session.owner,
						repo: session.repo,
						issueNumber: session.issueNumber,
					})
				}
				title="Mark complete"
			>
				✅ Mark complete
	</button>
			<button
				className="btn btn-warning"
				disabled={!!busy}
				onClick={() => {
					const confirmDirty =
						session.stale?.worktreeDirty &&
						!window.confirm("Worktree is dirty. Confirm prune?");
					if (confirmDirty) return;
					postAction("/api/sessions/prune-worktree", {
						owner: session.owner,
						repo: session.repo,
						issueNumber: session.issueNumber,
						confirmDirty: !!session.stale?.worktreeDirty,
					});
				}}
				title="Prune worktree"
			>
				🧹 Prune
			</button>
			{busy && <span className="action-busy">Working...</span>}
			{error && <span className="action-error">{error}</span>}
		</div>
	);
}

function SessionTable({ sessions }: { sessions: Session[] }): React.ReactElement {
	if (sessions.length === 0) {
		return <div className="empty">No active sessions</div>;
	}

	const active = sessions.filter((s) => !s.stale?.isStale);
	const stale = sessions.filter((s) => s.stale?.isStale);

	return (
		<>
			{stale.length > 0 && (
				<>
					<h2 className="section-heading stale-heading">⏰ Stale Sessions ({stale.length})</h2>
					<table className="stale-table">
						<thead>
							<tr>
								<th>Repo</th>
								<th>Issue</th>
								<th>Status</th>
								<th>Stale Age</th>
								<th>Classification</th>
								<th>Worktree</th>
								<th>GitHub State</th>
								<th>Actions</th>
							</tr>
						</thead>
						<tbody>
							{stale.map((session) => (
								<tr key={`stale-${session.owner}/${session.repo}#${session.issueNumber}`}>
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
									<td>{session.stale ? formatDuration(session.stale.ageMinutes) : "-"}</td>
									<td>
										<span className={`classification-badge ${session.stale?.classification}`}>
											{classificationLabel(session.stale?.classification ?? "unknown")}
										</span>
									</td>
									<td>
										{session.stale?.worktreeDirty === true
											? <span className="dirty">Dirty</span>
											: session.stale?.worktreeDirty === false
												? <span className="clean">Clean</span>
												: "-"}
									</td>
									<td>
										{session.stale?.issueState && (
											<span className="meta-badge">issue:{session.stale.issueState}</span>
										)}
										{session.stale?.prState && (
											<span className="meta-badge">pr:{session.stale.prState}</span>
										)}
									</td>
									<td><AdminActions session={session} /></td>
								</tr>
							))}
						</tbody>
					</table>
				</>
			)}
			{active.length > 0 && (
				<>
					<h2 className="section-heading">Active Sessions ({active.length})</h2>
					<table>
						<thead>
							<tr>
								<th>Repo</th>
								<th>Issue</th>
								<th>Status</th>
								<th>Workspace</th>
								<th>Last Activity</th>
								<th>PR</th>
							</tr>
						</thead>
						<tbody>
							{active.map((session) => (
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
								</tr>
							))}
						</tbody>
					</table>
				</>
			)}
		</>
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
