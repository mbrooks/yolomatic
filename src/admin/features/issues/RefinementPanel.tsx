import React, { useEffect, useRef, useState } from "react";
import { useRefinementLog } from "../../hooks/useRefinementLog.js";
import { formatRelative, formatMs } from "../../lib/format.js";

/**
 * Shows all durable issue-refinement activity for an issue in the admin UI,
 * mirroring the activity log shown for coding tasks. Lists refinement
 * attempts and streams the recorded activity log live.
 */
export function RefinementPanel({
	owner,
	repo,
	issueNumber,
}: {
	owner: string;
	repo: string;
	issueNumber: number;
}): React.ReactElement {
	const activity = useRefinementLog(owner, repo, issueNumber);
	const [autoScroll, setAutoScroll] = useState(true);
	const logFeedRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (autoScroll && logFeedRef.current && activity.logs.length > 0) {
			logFeedRef.current.scrollTop = logFeedRef.current.scrollHeight;
		}
	}, [activity.logs, autoScroll]);

	const hasActivity = activity.attempts.length > 0 || activity.logs.length > 0;

	if (activity.status === "idle" || (activity.status === "loading" && !hasActivity)) {
		return (
			<div className="detail-section">
				<h3>Refinement activity</h3>
				<div className="log-status">Loading refinement activity…</div>
			</div>
		);
	}

	if (activity.status === "error" && !hasActivity) {
		return (
			<div className="detail-section">
				<h3>Refinement activity</h3>
				<div className="log-status log-error">{activity.error ?? "No refinement activity for this issue."}</div>
			</div>
		);
	}

	if (!hasActivity) {
		return (
			<div className="detail-section">
				<h3>Refinement activity</h3>
				<div className="log-status">No refinement activity for this issue.</div>
			</div>
		);
	}

	return (
		<div className="detail-section">
			<h3>Refinement activity</h3>

			{activity.attempts.length > 0 ? (
				<div className="refinement-attempts">
					{activity.attempts.map((attempt) => (
						<div key={attempt.id} className="refinement-attempt">
							<span className={`status-badge ${attempt.state}`}>{attempt.state}</span>
							<span className="refinement-attempt-requester">@{attempt.requester}</span>
							<span className="refinement-attempt-time" title={attempt.createdAt}>
								{formatRelative(attempt.createdAt)}
							</span>
							{attempt.instructionSource === "repository-skill" ? (
								<span className="refinement-attempt-source">repo skill</span>
							) : (
								<span className="refinement-attempt-source">built-in</span>
							)}
							<span className="refinement-attempt-runtime" title="refinement runtime">
								{formatMs(attempt.runtimeMs ?? null)}
							</span>
							<span className="refinement-attempt-tokens" title="token usage">
								{attempt.tokenUsage
									? attempt.tokenUsage.available
										? attempt.tokenUsage.totalTokens.toLocaleString()
										: "unknown"
									: "unknown"}
							</span>
							{attempt.summary ? <div className="refinement-attempt-summary">{attempt.summary}</div> : null}
							{attempt.failureReason ? (
								<div className="refinement-attempt-reason">{attempt.failureReason}</div>
							) : null}
						</div>
					))}
				</div>
			) : null}

			<div className="log-controls">
				<label>
					<input
						type="checkbox"
						checked={autoScroll}
						onChange={(e) => setAutoScroll(e.target.checked)}
					/>{" "}
					Auto-scroll
				</label>
			</div>
			<div ref={logFeedRef} className="log-feed">
				{activity.logs.length === 0 ? (
					<div style={{ color: "#8b949e" }}>No activity logs</div>
				) : (
					activity.logs.map((entry) => {
						const ts = entry.timestamp.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
						return (
							<div
								key={`${entry.timestamp}-${entry.level}-${entry.message.slice(0, 20)}`}
								className="log-entry"
							>
								<span className="log-ts">{ts} </span>
								<span className={`log-level-${entry.level}`}>[{entry.level.toUpperCase()}]</span>{" "}
								{entry.message}
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}