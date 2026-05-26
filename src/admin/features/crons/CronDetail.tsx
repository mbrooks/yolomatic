import React, { useEffect, useState } from "react";
import { ActionButton, useAction } from "../../components/ActionButton.js";
import { deleteCron, fetchCronRuns, runCron, updateCron } from "../../api/crons.js";
import { formatRelative } from "../../lib/format.js";
import type { CronJob, CronRun } from "../../app/types.js";

export function CronDetail({
	cron,
	owner,
	repo,
	onMutate,
	onEdit,
}: {
	cron: CronJob | null;
	owner: string;
	repo: string;
	onMutate: () => void;
	onEdit: () => void;
}): React.ReactElement {
	const [runs, setRuns] = useState<CronRun[]>([]);
	const [loadingRuns, setLoadingRuns] = useState(false);

	useEffect(() => {
		if (!cron) {
			return;
		}
		setLoadingRuns(true);
		fetchCronRuns(owner, repo, cron.id)
			.then((data) => setRuns(data.runs))
			.catch(() => setRuns([]))
			.finally(() => setLoadingRuns(false));
	}, [cron, owner, repo]);

	if (!cron) {
		return (
			<div className="detail-pane empty">
				Select a cron job from the list to view details and actions.
			</div>
		);
	}

	return (
		<div className="detail-pane">
			<div className="detail-title">{cron.name}</div>

			<div className="detail-section">
				<h3>Summary</h3>
				<dl className="detail-grid">
					<dt>Status</dt>
					<dd>
						{cron.enabled ? (
							<span className="cron-status-dot success">enabled</span>
						) : (
							<span className="cron-status-dot failure">disabled</span>
						)}
					</dd>
					<dt>Schedule</dt>
					<dd>
						<span className="cron-schedule-badge">{cron.scheduleType}</span> {cron.scheduleValue}
					</dd>
					<dt>Branch</dt>
					<dd>{cron.branch}</dd>
					<dt>Next run</dt>
					<dd>{formatRelative(cron.nextRunAt)}</dd>
					<dt>Last run</dt>
					<dd>{cron.lastRunAt ? formatRelative(cron.lastRunAt) : "Never"}</dd>
					<dt>Notification</dt>
					<dd>{cron.notificationChannel || "None"}</dd>
					<dt>Pull Request</dt>
					<dd>
						{cron.prUrl ? (
							<a href={cron.prUrl} target="_blank" rel="noreferrer">
								PR #{cron.prNumber ?? "open"}
							</a>
						) : (
							"None"
						)}
					</dd>
				</dl>
			</div>

			<div className="detail-section">
				<h3>Prompt</h3>
				<pre className="cron-prompt">{cron.prompt}</pre>
			</div>

			<div className="detail-section">
				<h3>Actions</h3>
				<div className="detail-actions">
					<button className="action-btn" type="button" onClick={onEdit}>
						Edit
					</button>
					<CronActionControl
						owner={owner}
						repo={repo}
						cron={cron}
						action={cron.enabled ? "pause" : "resume"}
						onMutate={onMutate}
					/>
					<CronActionControl owner={owner} repo={repo} cron={cron} action="run" onMutate={onMutate} />
					<CronActionControl
						owner={owner}
						repo={repo}
						cron={cron}
						action="delete"
						onMutate={onMutate}
					/>
				</div>
			</div>

			<div className="detail-section">
				<h3>Execution History</h3>
				{loadingRuns ? (
					<div className="log-status">Loading runs...</div>
				) : runs.length === 0 ? (
					<div className="log-status">No runs yet.</div>
				) : (
					<div className="cron-runs-list">
						{runs.map((run) => (
							<div key={run.id} className={`cron-run-row ${run.status}`}>
								<div className="cron-run-meta">
									<span className={`cron-run-status ${run.status}`}>{run.status}</span>
									<span className="cron-run-time">{new Date(run.startedAt).toLocaleString()}</span>
								</div>
								<pre className="cron-run-output">{run.output}</pre>
								{run.error ? <div className="cron-run-error">Error: {run.error}</div> : null}
							</div>
						))}
						{runs.length >= 50 ? <div className="log-truncation-notice">Showing last 50 runs.</div> : null}
					</div>
				)}
			</div>
		</div>
	);
}

function CronActionControl({
	owner,
	repo,
	cron,
	action,
	onMutate,
}: {
	owner: string;
	repo: string;
	cron: CronJob;
	action: "pause" | "resume" | "run" | "delete";
	onMutate: () => void;
}): React.ReactElement {
	const config = {
		pause: { label: "Pause", loadingLabel: "Pausing...", variant: "pause" as const },
		resume: { label: "Resume", loadingLabel: "Resuming...", variant: "restart" as const },
		run: { label: "Run Now", loadingLabel: "Queuing...", variant: "complete" as const },
		delete: { label: "Delete", loadingLabel: "Deleting...", variant: "delete" as const },
	}[action];

	const { loading, result, execute } = useAction(async () => {
		if (action === "delete" && !window.confirm(`Delete cron job "${cron.name}"?`)) {
			return { ok: true, message: "Cancelled." };
		}

		if (action === "pause") {
			await updateCron(owner, repo, cron.id, { enabled: false });
		} else if (action === "resume") {
			await updateCron(owner, repo, cron.id, { enabled: true });
		} else if (action === "run") {
			await runCron(owner, repo, cron.id);
		} else {
			await deleteCron(owner, repo, cron.id);
		}

		onMutate();
		return { ok: true, message: "Done." };
	});

	return (
		<ActionButton
			label={config.label}
			loadingLabel={config.loadingLabel}
			variant={config.variant}
			onClick={() => execute()}
			disabled={loading}
			result={result}
		/>
	);
}
