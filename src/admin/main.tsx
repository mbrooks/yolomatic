import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

type AgentStatus = "online" | "busy" | "feedback" | "offline";
type SessionStatus = "pending" | "working" | "waiting-feedback" | "complete" | "failed" | "cancelled";

const TERMINAL_STATUSES: readonly SessionStatus[] = ["complete", "failed", "cancelled"];

function isTerminalStatus(status: SessionStatus): boolean {
	return TERMINAL_STATUSES.includes(status);
}

type StaleInfo = {
	isStale: boolean;
	ageMinutes: number;
	classification: string;
	worktreeDirty: boolean | null;
	issueState: string | null;
	prState: string | null;
};

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

function useAction<Args extends unknown[]>(
	handler: (...args: Args) => Promise<{ ok: boolean; message: string }>,
): {
	loading: boolean;
	result: string | null;
	execute: (...args: Args) => void;
} {
	const [loading, setLoading] = useState(false);
	const [result, setResult] = useState<string | null>(null);

	const execute = useCallback(
		async (...args: Args) => {
			setLoading(true);
			setResult(null);
			try {
				const res = await handler(...args);
				setResult(res.ok ? res.message : `Error: ${res.message}`);
			} catch (error) {
				setResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				setLoading(false);
			}
		},
		[handler],
	);

	return { loading, result, execute };
}

function ActionButton({
	label,
	loadingLabel,
	variant,
	onClick,
	disabled,
	result,
}: {
	label: string;
	loadingLabel: string;
	variant: string;
	onClick: () => void;
	disabled: boolean;
	result: string | null;
}): React.ReactElement {
	return (
		<div className="action-row">
			<button type="button" className={`action-btn ${variant}`} onClick={onClick} disabled={disabled}>
				{disabled ? loadingLabel : label}
			</button>
			{result && <span className="action-result">{result}</span>}
		</div>
	);
}

function StopButton({
	owner,
	repo,
	issueNumber,
	onStopped,
}: {
	owner: string;
	repo: string;
	issueNumber: number;
	onStopped?: () => void;
}): React.ReactElement {
	const { loading, result, execute } = useAction(async () => {
		if (!window.confirm(`Stop TARS on ${owner}/${repo}#${issueNumber}?`)) return { ok: false, message: "Cancelled" };
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}/cancel`,
			{ method: "POST" },
		);
		const data = (await response.json()) as { message?: string; error?: string };
		if (response.ok) {
			onStopped?.();
			return { ok: true, message: data.message ?? "Stopped." };
		}
		return { ok: false, message: data.error ?? response.statusText };
	});

	return (
		<ActionButton
			label="Stop"
			loadingLabel="Stopping…"
			variant="stop"
			onClick={execute}
			disabled={loading}
			result={result}
		/>
	);
}

function DeleteButton({
	owner,
	repo,
	issueNumber,
	onDeleted,
}: {
	owner: string;
	repo: string;
	issueNumber: number;
	onDeleted?: () => void;
}): React.ReactElement {
	const { loading, result, execute } = useAction(async () => {
		if (!window.confirm(`Delete session and workspace for ${owner}/${repo}#${issueNumber}? This cannot be undone.`))
			return { ok: false, message: "Cancelled" };
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}/delete`,
			{ method: "POST" },
		);
		const data = (await response.json()) as { message?: string; error?: string };
		if (response.ok) {
			onDeleted?.();
			return { ok: true, message: data.message ?? "Deleted." };
		}
		return { ok: false, message: data.error ?? response.statusText };
	});

	return (
		<ActionButton
			label="Delete"
			loadingLabel="Deleting…"
			variant="delete"
			onClick={execute}
			disabled={loading}
			result={result}
		/>
	);
}

function MarkFailedButton({
	owner,
	repo,
	issueNumber,
	onMarked,
}: {
	owner: string;
	repo: string;
	issueNumber: number;
	onMarked?: () => void;
}): React.ReactElement {
	const { loading, result, execute } = useAction(async () => {
		if (!window.confirm(`Mark ${owner}/${repo}#${issueNumber} failed?`)) return { ok: false, message: "Cancelled" };
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}/mark-failed`,
			{ method: "POST" },
		);
		const data = (await response.json()) as { message?: string; error?: string };
		if (response.ok) {
			onMarked?.();
			return { ok: true, message: data.message ?? "Marked failed." };
		}
		return { ok: false, message: data.error ?? response.statusText };
	});

	return (
		<ActionButton
			label="Mark failed"
			loadingLabel="Marking…"
			variant="warn"
			onClick={execute}
			disabled={loading}
			result={result}
		/>
	);
}

function MarkCompleteButton({
	owner,
	repo,
	issueNumber,
	onMarked,
}: {
	owner: string;
	repo: string;
	issueNumber: number;
	onMarked?: () => void;
}): React.ReactElement {
	const { loading, result, execute } = useAction(async () => {
		if (!window.confirm(`Mark ${owner}/${repo}#${issueNumber} complete?`)) return { ok: false, message: "Cancelled" };
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}/mark-complete`,
			{ method: "POST" },
		);
		const data = (await response.json()) as { message?: string; error?: string };
		if (response.ok) {
			onMarked?.();
			return { ok: true, message: data.message ?? "Marked complete." };
		}
		return { ok: false, message: data.error ?? response.statusText };
	});

	return (
		<ActionButton
			label="Mark complete"
			loadingLabel="Marking…"
			variant="complete"
			onClick={execute}
			disabled={loading}
			result={result}
		/>
	);
}

function RestartButton({
	owner,
	repo,
	issueNumber,
	onRestarted,
}: {
	owner: string;
	repo: string;
	issueNumber: number;
	onRestarted?: () => void;
}): React.ReactElement {
	const { loading, result, execute } = useAction(async () => {
		if (!window.confirm(`This will reset the workspace and re-queue the session for ${owner}/${repo}#${issueNumber}. Proceed?`))
			return { ok: false, message: "Cancelled" };
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}/restart`,
			{ method: "POST" },
		);
		const data = (await response.json()) as { message?: string; error?: string };
		if (response.ok) {
			onRestarted?.();
			return { ok: true, message: data.message ?? "Restarted." };
		}
		return { ok: false, message: data.error ?? response.statusText };
	});

	return (
		<ActionButton
			label="Restart"
			loadingLabel="Restarting…"
			variant="restart"
			onClick={execute}
			disabled={loading}
			result={result}
		/>
	);
}

function ArchiveButton({
	owner,
	repo,
	issueNumber,
	onArchived,
}: {
	owner: string;
	repo: string;
	issueNumber: number;
	onArchived?: () => void;
}): React.ReactElement {
	const { loading, result, execute } = useAction(async () => {
		if (!window.confirm(`Archive ${owner}/${repo}#${issueNumber}? Session files will be moved to archive directory.`))
			return { ok: false, message: "Cancelled" };
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}/archive`,
			{ method: "POST" },
		);
		const data = (await response.json()) as { message?: string; error?: string };
		if (response.ok) {
			onArchived?.();
			return { ok: true, message: data.message ?? "Archived." };
		}
		return { ok: false, message: data.error ?? response.statusText };
	});

	return (
		<ActionButton
			label="Archive"
			loadingLabel="Archiving…"
			variant="archive"
			onClick={execute}
			disabled={loading}
			result={result}
		/>
	);
}

function PruneWorktreeButton({
	owner,
	repo,
	issueNumber,
	onPruned,
}: {
	owner: string;
	repo: string;
	issueNumber: number;
	onPruned?: () => void;
}): React.ReactElement {
	const { loading, result, execute } = useAction(async () => {
		if (!window.confirm(`Prune worktree for ${owner}/${repo}#${issueNumber}?`)) return { ok: false, message: "Cancelled" };
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}/prune-worktree`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirmDirty: true }),
			},
		);
		const data = (await response.json()) as { message?: string; error?: string };
		if (response.ok) {
			onPruned?.();
			return { ok: true, message: data.message ?? "Pruned." };
		}
		return { ok: false, message: data.error ?? response.statusText };
	});

	return (
		<ActionButton
			label="Prune worktree"
			loadingLabel="Pruning…"
			variant="prune"
			onClick={execute}
			disabled={loading}
			result={result}
		/>
	);
}

function BulkDeleteButton({ count, onDeleted }: { count: number; onDeleted?: () => void }): React.ReactElement {
	const { loading, result, execute } = useAction(async () => {
		if (!window.confirm(`Delete all ${count} terminal sessions and their workspaces? This cannot be undone.`))
			return { ok: false, message: "Cancelled" };
		const response = await fetch("/api/sessions/delete-completed", { method: "POST" });
		const data = (await response.json()) as { deleted?: number; error?: string };
		if (response.ok) {
			onDeleted?.();
			return { ok: true, message: `${data.deleted ?? 0} deleted.` };
		}
		return { ok: false, message: data.error ?? response.statusText };
	});

	return (
		<ActionButton
			label={`Delete all completed (${count})`}
			loadingLabel="Deleting…"
			variant="delete bulk"
			onClick={execute}
			disabled={loading}
			result={result}
		/>
	);
}

function SessionRisk({ session }: { session: Session }): React.ReactElement {
	if (!session.risk.suspectedMisroute) {
		return <span className="risk-ok">OK</span>;
	}

	return (
		<div className="risk-warning">
			<strong>Check mapping</strong>
			{session.risk.referencedIssueNumber && <span> references #{session.risk.referencedIssueNumber}</span>}
			<ul>
				{session.risk.reasons.map((reason) => (
					<li key={reason}>{reason}</li>
				))}
			</ul>
		</div>
	);
}

function SessionActions({
	session,
	onMutate,
}: {
	session: Session;
	onMutate?: () => void;
}): React.ReactElement {
	const { owner, repo, issueNumber, status } = session;
	const common = { owner, repo, issueNumber };

	const canCancel = status === "working" || status === "pending" || status === "waiting-feedback";
	const canRestart = status === "failed" || status === "cancelled";
	const canDelete = isTerminalStatus(status);

	return (
		<div className="detail-actions">
			<h3>Actions</h3>
			{canCancel && <StopButton {...common} onStopped={onMutate} />}
			{canRestart && <RestartButton {...common} onRestarted={onMutate} />}
			{canDelete && <DeleteButton {...common} onDeleted={onMutate} />}
			<MarkFailedButton {...common} onMarked={onMutate} />
			<MarkCompleteButton {...common} onMarked={onMutate} />
			<ArchiveButton {...common} onArchived={onMutate} />
			<PruneWorktreeButton {...common} onPruned={onMutate} />
		</div>
	);
}

function SessionDetail({
	session,
	onMutate,
}: {
	session: Session;
	onMutate?: () => void;
}): React.ReactElement {
	return (
		<div className="detail-pane">
			<h2 className="detail-title">
				<a href={`https://github.com/${session.owner}/${session.repo}/issues/${session.issueNumber}`} target="_blank" rel="noreferrer">
					{session.owner}/{session.repo}#{session.issueNumber}
				</a>
			</h2>

			<div className="detail-section">
				<h3>Status</h3>
				<div className="detail-row">
					<span className={`status-badge ${session.status}`}>{session.status}</span>
					{session.stale?.isStale && (
						<span className="stale-badge">Stale — {session.stale.classification}</span>
					)}
				</div>
			</div>

			<div className="detail-section">
				<h3>Details</h3>
				<dl className="detail-grid">
					<dt>Workspace</dt>
					<dd>{session.workspacePath}</dd>

					<dt>Branch</dt>
					<dd>{session.branch}</dd>

					<dt>Last Activity</dt>
					<dd>{formatRelative(session.lastActivity)}</dd>

					<dt>PR</dt>
					<dd>
						{session.prUrl && session.prNumber ? (
							<a href={session.prUrl} target="_blank" rel="noreferrer">
								#{session.prNumber}
							</a>
						) : (
							"-"
						)}
					</dd>

					<dt>Risk</dt>
					<dd>
						<SessionRisk session={session} />
					</dd>
				</dl>
			</div>

			{session.stale && (
				<div className="detail-section">
					<h3>Stale Info</h3>
					<dl className="detail-grid">
						<dt>Age</dt>
						<dd>{session.stale.ageMinutes}m</dd>
						<dt>Classification</dt>
						<dd>{session.stale.classification}</dd>
						<dt>Worktree</dt>
						<dd>
							{session.stale.worktreeDirty === true ? "dirty" : session.stale.worktreeDirty === false ? "clean" : "?"}
						</dd>
						<dt>Issue State</dt>
						<dd>{session.stale.issueState ?? "-"}</dd>
						<dt>PR State</dt>
						<dd>{session.stale.prState ?? "-"}</dd>
					</dl>
				</div>
			)}

			<SessionActions session={session} onMutate={onMutate} />
		</div>
	);
}

function EmptyDetail(): React.ReactElement {
	return (
		<div className="detail-pane empty">
			<p>Select a session from the list to view details and actions.</p>
		</div>
	);
}

function SessionList({
	sessions,
	selected,
	onSelect,
}: {
	sessions: Session[];
	selected: Session | null;
	onSelect: (session: Session) => void;
}): React.ReactElement {
	if (sessions.length === 0) {
		return <div className="empty">No active sessions</div>;
	}

	return (
		<div className="list-pane">
			<div className="list-header">
				<div className="list-col repo">Repo</div>
				<div className="list-col issue">Issue</div>
				<div className="list-col status">Status</div>
				<div className="list-col activity">Last Activity</div>
			</div>
			<div className="list-body">
				{sessions.map((session) => {
					const key = `${session.owner}/${session.repo}#${session.issueNumber}`;
					const isSelected =
						selected !== null &&
						selected.owner === session.owner &&
						selected.repo === session.repo &&
						selected.issueNumber === session.issueNumber;
					return (
						<div
							key={key}
							className={`list-row ${isSelected ? "selected" : ""}`}
							onClick={() => onSelect(session)}
							tabIndex={0}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									onSelect(session);
								}
							}}
							role="button"
						>
							<div className="list-col repo">
								{session.owner}/{session.repo}
							</div>
							<div className="list-col issue">#{session.issueNumber}</div>
							<div className="list-col status">
								<span className={`status-badge ${session.status}`}>{session.status}</span>
							</div>
							<div className="list-col activity">{formatRelative(session.lastActivity)}</div>
							{session.stale?.isStale && <span className="stale-dot" title={`Stale — ${session.stale.classification}`} />}
						</div>
					);
				})}
			</div>
		</div>
	);
}

function App(): React.ReactElement {
	const [tick, setTick] = useState(0);
	const state = useStatus(tick);
	const [selected, setSelected] = useState<Session | null>(null);

	const agentStatus: AgentStatus = state.status === "ready" ? state.data.agent : "offline";
	const sessions = state.status === "ready" ? state.data.sessions : [];
	const terminalCount = sessions.filter((s) => isTerminalStatus(s.status)).length;

	const lastUpdated = useMemo(() => {
		if (state.status === "loading") return "Loading...";
		if (state.status === "error") return `Error: ${state.error}`;
		return `Last updated: ${state.updatedAt.toLocaleTimeString()}`;
	}, [state]);

	const handleMutate = useCallback(() => {
		setTick((t) => t + 1);
	}, []);

	const selectedSession = useMemo(() => {
		if (!selected) return null;
		return (
			sessions.find(
				(s) =>
					s.owner === selected.owner && s.repo === selected.repo && s.issueNumber === selected.issueNumber,
			) ?? null
		);
	}, [sessions, selected]);

	return (
		<div className="app">
			<header>
				<h1>TARS Admin</h1>
				<div className="header-actions">
					<StatusBadge status={agentStatus} />
					{terminalCount > 0 && <BulkDeleteButton count={terminalCount} onDeleted={handleMutate} />}
				</div>
			</header>
			{state.status === "error" ? (
				<div className="empty">Unable to reach API</div>
			) : (
				<div className="workspace">
					<SessionList sessions={sessions} selected={selectedSession} onSelect={setSelected} />
					{selectedSession ? (
						<SessionDetail session={selectedSession} onMutate={handleMutate} />
					) : (
						<EmptyDetail />
					)}
				</div>
			)}
			<div className="last-updated">{lastUpdated}</div>
		</div>
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
