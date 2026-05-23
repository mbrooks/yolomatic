import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Breadcrumb } from "../../components/Breadcrumb.js";
import { EmptyState } from "../../components/EmptyState.js";
import { ActionButton, useAction } from "../../components/ActionButton.js";
import { formatRelative } from "../../lib/format.js";
import {
	fetchCrons,
	createCron,
	updateCron,
	deleteCron,
	runCron,
	fetchCronRuns,
} from "../../api/crons.js";
import type { CronJob, CronRun } from "../../app/types.js";

export function CronScreen({
	owner,
	repo,
	activeTab,
	onSelectTab,
	onBack,
	onNewIssue,
}: {
	owner: string;
	repo: string;
	activeTab: "sessions" | "crons";
	onSelectTab: (tab: "sessions" | "crons") => void;
	onBack: () => void;
	onNewIssue?: () => void;
}): React.ReactElement {
	const [crons, setCrons] = useState<CronJob[]>([]);
	const [loading, setLoading] = useState(true);
	const [selectedCron, setSelectedCron] = useState<CronJob | null>(null);
	const [showForm, setShowForm] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const data = await fetchCrons(owner, repo);
			setCrons(data.crons);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`Failed to load crons: ${message}\n`);
		} finally {
			setLoading(false);
		}
	}, [owner, repo]);

	useEffect(() => {
		void load();
	}, [load]);

	const handleMutate = useCallback(() => {
		void load();
		setSelectedCron(null);
	}, [load]);

	return (
		<>
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
				{onNewIssue && (
					<button
						className="repo-tab new-issue"
						onClick={onNewIssue}
						type="button"
					>
						+ New Issue
					</button>
				)}
			</div>
			<Breadcrumb label={`${owner}/${repo}`} onBack={onBack} />
			{loading ? (
				<div className="empty">Loading crons...</div>
			) : crons.length === 0 && !showForm ? (
				<EmptyState message="No cron jobs for this repository.">
					<button
						className="action-btn restart"
						onClick={() => setShowForm(true)}
						type="button"
					>
						+ New Cron Job
					</button>
				</EmptyState>
			) : (
				<div className="workspace">
					<div className="list-pane">
						<div className="list-header cron-list-header">
							<div className="list-col cron-name">Name</div>
							<div className="list-col cron-schedule">Schedule</div>
							<div className="list-col cron-status">Status</div>
							<div className="list-col cron-next">Next Run</div>
						</div>
						<div className="list-body">
							{crons.map((cron) => {
								const isSelected = selectedCron?.id === cron.id;
								return (
									<div
										key={cron.id}
										className={`list-row${isSelected ? " selected" : ""}`}
										onClick={() => {
											setSelectedCron(cron);
											setShowForm(false);
										}}
										tabIndex={0}
										role="button"
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												setSelectedCron(cron);
												setShowForm(false);
											}
										}}
									>
										<div className="list-col cron-name">
											{cron.name}
											{cron.enabled ? null : (
												<span className="cron-paused-badge">paused</span>
											)}
										</div>
										<div className="list-col cron-schedule">
											<span className="cron-schedule-badge">{cron.scheduleType}</span>
											{cron.scheduleValue}
										</div>
										<div className="list-col cron-status">
											{cron.lastRunStatus ? (
												<span className={`cron-status-dot ${cron.lastRunStatus}`} title={cron.lastError ?? undefined}>
													{cron.lastRunStatus}
												</span>
											) : (
												<span className="cron-status-dot">never run</span>
											)}
										</div>
										<div className="list-col cron-next">{formatRelative(cron.nextRunAt)}</div>
									</div>
								);
							})}
						</div>
						<button
							className="action-btn restart new-cron-btn"
							onClick={() => {
								setShowForm(true);
								setSelectedCron(null);
							}}
							type="button"
						>
							+ New Cron Job
						</button>
					</div>

					{showForm ? (
						<CronForm
							owner={owner}
							repo={repo}
							existing={selectedCron}
							onComplete={handleMutate}
							onCancel={() => {
								setShowForm(false);
							}}
						/>
					) : (
						<CronDetail
							cron={selectedCron}
							owner={owner}
							repo={repo}
							onMutate={handleMutate}
							onEdit={() => setShowForm(true)}
						/>
					)}
				</div>
			)}
		</>
	);
}

function CronForm({
	owner,
	repo,
	existing,
	onComplete,
	onCancel,
}: {
	owner: string;
	repo: string;
	existing: CronJob | null;
	onComplete: () => void;
	onCancel: () => void;
}): React.ReactElement {
	const [name, setName] = useState(existing?.name ?? "");
	const [description, setDescription] = useState(existing?.description ?? "");
	const [prompt, setPrompt] = useState(existing?.prompt ?? "");
	const [scheduleType, setScheduleType] = useState(existing?.scheduleType ?? "daily");
	const [scheduleValue, setScheduleValue] = useState(existing?.scheduleValue ?? "09:00");
	const [branch, setBranch] = useState(existing?.branch ?? "main");
	const [notificationChannel, setNotificationChannel] = useState<string>(existing?.notificationChannel ?? "");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			setSaving(true);
			setError(null);
			try {
				if (existing) {
					await updateCron(owner, repo, existing.id, {
						name,
						description,
						prompt,
						scheduleType,
						scheduleValue,
						branch,
						notificationChannel: notificationChannel || null,
					});
				} else {
					await createCron(owner, repo, {
						name,
						description,
						prompt,
						scheduleType,
						scheduleValue,
						branch,
						notificationChannel: notificationChannel || undefined,
					});
				}
				onComplete();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setSaving(false);
			}
		},
		[owner, repo, existing, name, description, prompt, scheduleType, scheduleValue, branch, notificationChannel, onComplete],
	);

	return (
		<div className="detail-pane">
			<div className="detail-title">{existing ? "Edit Cron Job" : "New Cron Job"}</div>
			<form onSubmit={handleSubmit} className="cron-form">
				<div className="form-group">
					<label>Name</label>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						required
						maxLength={120}
					/>
				</div>
				<div className="form-group">
					<label>Description</label>
					<input
						type="text"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						maxLength={255}
					/>
				</div>
				<div className="form-group">
					<label>Prompt / Instructions</label>
					<textarea
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						required
						rows={6}
					/>
				</div>
				<div className="form-row">
					<div className="form-group">
						<label>Schedule Type</label>
						<select value={scheduleType} onChange={(e) => setScheduleType(e.target.value as import("../../app/types.js").CronScheduleType)}>
							<option value="daily">Daily</option>
							<option value="weekly">Weekly</option>
							<option value="interval">Interval</option>
							<option value="custom">Custom</option>
						</select>
					</div>
					<div className="form-group">
						<label>Schedule Value</label>
						<input
							type="text"
							value={scheduleValue}
							onChange={(e) => setScheduleValue(e.target.value)}
							required
							placeholder={
								scheduleType === "daily"
									? "09:00"
									: scheduleType === "weekly"
										? "mon 09:00"
										: scheduleType === "interval"
											? "2h"
											: "cron expression"
							}
						/>
					</div>
				</div>
				<div className="form-group">
					<label>Branch Target</label>
					<input
						type="text"
						value={branch}
						onChange={(e) => setBranch(e.target.value)}
						placeholder="main"
					/>
				</div>
				<div className="form-group">
					<label>Notification Channel (optional)</label>
					<input
						type="text"
						value={notificationChannel}
						onChange={(e) => setNotificationChannel(e.target.value)}
						placeholder="issue:123"
					/>
				</div>
				{error ? <div className="form-error">{error}</div> : null}
				<div className="detail-actions">
					<button className="action-btn complete" type="submit" disabled={saving}>
						{saving ? "Saving..." : "Save"}
					</button>
					<button className="action-btn" type="button" onClick={onCancel} disabled={saving}>
						Cancel
					</button>
				</div>
			</form>
		</div>
	);
}

function CronDetail({
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
		if (!cron) return;
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
					<CronActionControl
						owner={owner}
						repo={repo}
						cron={cron}
						action="run"
						onMutate={onMutate}
					/>
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
						{runs.length >= 50 ? (
							<div className="log-truncation-notice">Showing last 50 runs.</div>
						) : null}
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
		} else if (action === "delete") {
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
