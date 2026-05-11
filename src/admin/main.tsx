import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

type AgentStatus = "online" | "busy" | "feedback" | "offline";
type SessionStatus = "pending" | "working" | "waiting-feedback" | "paused" | "complete" | "failed" | "cancelled";

export const TERMINAL_STATUSES: readonly SessionStatus[] = ["complete", "failed", "cancelled"];
export const IN_PROGRESS_STATUSES: readonly SessionStatus[] = ["working", "pending", "waiting-feedback", "paused"];
export const PAUSABLE_STATUSES: readonly SessionStatus[] = ["working", "pending", "waiting-feedback"];

export function isTerminalStatus(status: SessionStatus): boolean {
	return TERMINAL_STATUSES.includes(status);
}

export function isInProgressStatus(status: SessionStatus): boolean {
	return IN_PROGRESS_STATUSES.includes(status);
}

export function isPausableStatus(status: SessionStatus): boolean {
	return PAUSABLE_STATUSES.includes(status);
}

type StaleInfo = {
	isStale: boolean;
	ageMinutes: number;
	classification: string;
	worktreeDirty: boolean | null;
	issueState: string | null;
	prState: string | null;
};

type SessionLogResponse = {
	available: boolean;
	truncated?: boolean;
	totalLines?: number;
	lines?: string[];
	error?: string;
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

type RepoSummary = {
	owner: string;
	repo: string;
	sessionCount: number;
	activeCount: number;
};

type StatusResponse = {
	agent: Exclude<AgentStatus, "offline">;
	uptime: string;
	repos: RepoSummary[];
	sessions: Session[];
};

type ViewState =
	| { type: "repos" }
	| { type: "repo"; owner: string; repo: string }
	| { type: "working" };

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

type LogLoadState = {
	status: "idle" | "loading" | "ready" | "error";
	data: SessionLogResponse | null;
	error: string | null;
	refreshing: boolean;
};

export function useSessionLog(session: Session | null): LogLoadState {
	const [state, setState] = useState<LogLoadState>({
		status: "idle",
		data: null,
		error: null,
		refreshing: false,
	});
	const sessionKey = session ? `${session.owner}/${session.repo}#${session.issueNumber}` : null;

	useEffect(() => {
		if (!session) {
			setState({ status: "idle", data: null, error: null, refreshing: false });
			return;
		}

		const { owner, repo, issueNumber } = session;
		let cancelled = false;

		async function load(): Promise<void> {
			setState((current) => {
				if (current.data) {
					return {
						...current,
						error: null,
						refreshing: true,
					};
				}

				return {
					status: "loading",
					data: null,
					error: null,
					refreshing: false,
				};
			});
			try {
				const response = await fetch(
					`/api/sessions/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}/log`,
				);
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}`);
				}
				const data = (await response.json()) as SessionLogResponse;
				if (!cancelled) {
					setState({ status: "ready", data, error: null, refreshing: false });
				}
			} catch (error) {
				if (!cancelled) {
					const message = error instanceof Error ? error.message : String(error);
					setState((current) => {
						if (current.data) {
							return {
								...current,
								error: message,
								refreshing: false,
							};
						}

						return {
							status: "error",
							data: null,
							error: message,
							refreshing: false,
						};
					});
				}
			}
		}

		void load();

		if (session.status === "complete") {
			return () => {
				cancelled = true;
			};
		}

		const interval = window.setInterval(() => void load(), 5000);
		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	}, [sessionKey, session?.status]);

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

function PauseButton({
	owner,
	repo,
	issueNumber,
	onPaused,
}: {
	owner: string;
	repo: string;
	issueNumber: number;
	onPaused?: () => void;
}): React.ReactElement {
	const { loading, result, execute } = useAction(async () => {
		if (!window.confirm(`Pause TARS on ${owner}/${repo}#${issueNumber}?`)) return { ok: false, message: "Cancelled" };
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}/pause`,
			{ method: "POST" },
		);
		const data = (await response.json()) as { message?: string; error?: string };
		if (response.ok) {
			onPaused?.();
			return { ok: true, message: data.message ?? "Paused." };
		}
		return { ok: false, message: data.error ?? response.statusText };
	});

	return (
		<ActionButton
			label="Pause"
			loadingLabel="Pausing…"
			variant="pause"
			onClick={execute}
			disabled={loading}
			result={result}
		/>
	);
}

function ResumeButton({
	owner,
	repo,
	issueNumber,
	onResumed,
}: {
	owner: string;
	repo: string;
	issueNumber: number;
	onResumed?: () => void;
}): React.ReactElement {
	const { loading, result, execute } = useAction(async () => {
		if (!window.confirm(`Resume TARS on ${owner}/${repo}#${issueNumber}?`)) return { ok: false, message: "Cancelled" };
		const response = await fetch(
			`/api/sessions/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${issueNumber}/resume`,
			{ method: "POST" },
		);
		const data = (await response.json()) as { message?: string; error?: string };
		if (response.ok) {
			onResumed?.();
			return { ok: true, message: data.message ?? "Resumed." };
		}
		return { ok: false, message: data.error ?? response.statusText };
	});

	return (
		<ActionButton
			label="Resume"
			loadingLabel="Resuming…"
			variant="resume"
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
	const canPause = isPausableStatus(status);
	const canResume = status === "paused";
	const canRestart = status === "failed" || status === "cancelled";
	const canDelete = isTerminalStatus(status);
	const canMarkFailed = status !== "failed";
	const canMarkComplete = status !== "complete";

	return (
		<div className="detail-section">
			<h3>Actions</h3>
			<div className="detail-actions">
				{canCancel && <StopButton {...common} onStopped={onMutate} />}
				{canPause && <PauseButton {...common} onPaused={onMutate} />}
				{canResume && <ResumeButton {...common} onResumed={onMutate} />}
				{canRestart && <RestartButton {...common} onRestarted={onMutate} />}
				{canDelete && <DeleteButton {...common} onDeleted={onMutate} />}
				{canMarkFailed && <MarkFailedButton {...common} onMarked={onMutate} />}
				{canMarkComplete && <MarkCompleteButton {...common} onMarked={onMutate} />}
				<ArchiveButton {...common} onArchived={onMutate} />
				<PruneWorktreeButton {...common} onPruned={onMutate} />
			</div>
		</div>
	);
}

function SessionLog({ session }: { session: Session }): React.ReactElement {
	const logState = useSessionLog(session);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const scrollSnapshotRef = useRef({ stickToBottom: true, offsetFromBottom: 0 });
	const logText = logState.data?.lines?.join("\n") ?? "";

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const captureScroll = (): void => {
			const offsetFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
			scrollSnapshotRef.current = {
				stickToBottom: offsetFromBottom <= 24,
				offsetFromBottom,
			};
		};

		captureScroll();
		container.addEventListener("scroll", captureScroll);
		return () => {
			container.removeEventListener("scroll", captureScroll);
		};
	}, [session.owner, session.repo, session.issueNumber]);

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container || !logState.data?.available) return;

		if (scrollSnapshotRef.current.stickToBottom) {
			container.scrollTop = container.scrollHeight;
			return;
		}

		container.scrollTop = Math.max(
			0,
			container.scrollHeight - container.clientHeight - scrollSnapshotRef.current.offsetFromBottom,
		);
	}, [logText, logState.data?.available]);

	return (
		<div className="detail-section">
			<h3>LLM Session Log</h3>
			{logState.status === "loading" && !logState.data && (
				<div className="log-status">Loading log…</div>
			)}
			{logState.status === "error" && !logState.data && (
				<div className="log-status log-error">Error loading log: {logState.error}</div>
			)}
			{logState.data && (
				<div className="log-container" ref={containerRef}>
					{!logState.data.available ? (
						<div className="log-status">
							{logState.data.error ?? "Log unavailable"}
						</div>
					) : (
						<>
							{logState.refreshing && (
								<div className="log-refresh-notice">Refreshing…</div>
							)}
							{logState.error && (
								<div className="log-status log-error">Error loading log: {logState.error}</div>
							)}
							{logState.data.truncated && (
								<div className="log-truncation-notice">
									Log truncated ({logState.data.totalLines ?? 0} total lines; showing last {logState.data.lines?.length ?? 0})
								</div>
							)}
							<pre className="log-content">
								{logState.data.lines?.join("\n") ?? ""}
							</pre>
						</>
					)}
				</div>
			)}
			{logState.status === "idle" && (
				<div className="log-status">Select a session to view the log.</div>
			)}
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

			<SessionLog session={session} />

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

function RepoList({
	repos,
	onSelect,
	children,
}: {
	repos: RepoSummary[];
	onSelect: (owner: string, repo: string) => void;
	children?: React.ReactNode;
}): React.ReactElement {
	if (repos.length === 0 && !children) {
		return (
			<div className="empty-state">
				<p>No repositories have been used yet.</p>
			</div>
		);
	}

	return (
		<div className="repo-list">
			{children}
			{repos.map((repo) => (
				<div
					key={`${repo.owner}/${repo.repo}`}
					className="repo-card"
					onClick={() => onSelect(repo.owner, repo.repo)}
					tabIndex={0}
					role="button"
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onSelect(repo.owner, repo.repo);
						}
					}}
				>
					<div className="repo-card-name">{repo.owner}/{repo.repo}</div>
					<div className="repo-card-meta">
						{repo.sessionCount} session{repo.sessionCount !== 1 ? "s" : ""}
						{repo.activeCount > 0 ? ` · ${repo.activeCount} active` : ""}
					</div>
				</div>
			))}
		</div>
	);
}

function Breadcrumb({
	label,
	onBack,
}: {
	label: string;
	onBack: () => void;
}): React.ReactElement {
	return (
		<nav className="breadcrumb">
			<button type="button" className="breadcrumb-link" onClick={onBack}>Repos</button>
			<span className="breadcrumb-separator">→</span>
			<span className="breadcrumb-current">{label}</span>
		</nav>
	);
}

function SessionList({
	sessions,
	selected,
	onSelect,
	emptyMessage = "No active sessions",
}: {
	sessions: Session[];
	selected: Session | null;
	onSelect: (session: Session) => void;
	emptyMessage?: string;
}): React.ReactElement {
	if (sessions.length === 0) {
		return <div className="empty">{emptyMessage}</div>;
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

export function App(): React.ReactElement {
	const [tick, setTick] = useState(0);
	const state = useStatus(tick);
	const [selected, setSelected] = useState<Session | null>(null);
	const [view, setView] = useState<ViewState>({ type: "repos" });

	const agentStatus: AgentStatus = state.status === "ready" ? state.data.agent : "offline";
	const sessions = state.status === "ready" ? state.data.sessions : [];
	const repos = state.status === "ready" ? state.data.repos : [];

	const repoSessions = useMemo(() => {
		if (view.type !== "repo") return [];
		return sessions.filter((s) => s.owner === view.owner && s.repo === view.repo);
	}, [sessions, view]);

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

	const handleSelectRepo = useCallback((owner: string, repo: string) => {
		setView({ type: "repo", owner, repo });
		setSelected(null);
	}, []);

	const handleSelectWorking = useCallback(() => {
		setView({ type: "working" });
		setSelected(null);
	}, []);

	const handleBackToRepos = useCallback(() => {
		setView({ type: "repos" });
		setSelected(null);
	}, []);

	const workingSessions = useMemo(() => {
		return sessions.filter((s) => isInProgressStatus(s.status));
	}, [sessions]);

	const inProgressCount = workingSessions.length;

	return (
		<div className="app">
				<header>
				<h1>TARS Admin</h1>
				<div className="header-actions">
					<StatusBadge status={agentStatus} />
				</div>
			</header>
			{view.type === "repo" && (
				<Breadcrumb label={`${view.owner}/${view.repo}`} onBack={handleBackToRepos} />
			)}
			{view.type === "working" && (
				<Breadcrumb label="Active Tasks" onBack={handleBackToRepos} />
			)}
			{state.status === "error" ? (
				<div className="empty">Unable to reach API</div>
			) : (
				<div className="workspace">
					{view.type === "repos" ? (
						<RepoList repos={repos} onSelect={handleSelectRepo}>
							<div
								className="repo-card working-card"
								onClick={handleSelectWorking}
								tabIndex={0}
								role="button"
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										handleSelectWorking();
									}
								}}
							>
								<div className="repo-card-name">Active Tasks</div>
								<div className="repo-card-meta">
									{inProgressCount} active task{inProgressCount !== 1 ? "s" : ""}
								</div>
							</div>
						</RepoList>
					) : view.type === "working" ? (
						<>
							<SessionList
								sessions={workingSessions}
								selected={selectedSession}
								onSelect={setSelected}
								emptyMessage="No active tasks."
							/>
							{selectedSession ? (
								<SessionDetail session={selectedSession} onMutate={handleMutate} />
							) : (
								<EmptyDetail />
							)}
						</>
					) : (
						<>
							<SessionList
								sessions={repoSessions}
								selected={selectedSession}
								onSelect={setSelected}
								emptyMessage="No sessions for this repository."
							/>
							{selectedSession ? (
								<SessionDetail session={selectedSession} onMutate={handleMutate} />
							) : (
								<EmptyDetail />
							)}
						</>
					)}
				</div>
			)}
			<div className="last-updated">{lastUpdated}</div>
		</div>
	);
}

const rootEl = typeof document !== "undefined" ? document.getElementById("root") : null;
if (rootEl) {
	createRoot(rootEl).render(
		<React.StrictMode>
			<App />
		</React.StrictMode>,
	);
}
