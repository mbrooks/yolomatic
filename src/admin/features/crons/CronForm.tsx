import React, { useCallback, useState } from "react";
import { createCron, updateCron } from "../../api/crons.js";
import type { CronJob, CronScheduleType } from "../../app/types.js";

export function CronForm({
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
	const [scheduleType, setScheduleType] = useState<CronScheduleType>(existing?.scheduleType ?? "daily");
	const [scheduleValue, setScheduleValue] = useState(existing?.scheduleValue ?? "09:00");
	const [branch, setBranch] = useState(existing?.branch ?? "main");
	const [notificationChannel, setNotificationChannel] = useState(existing?.notificationChannel ?? "");
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
		[
			branch,
			description,
			existing,
			name,
			notificationChannel,
			onComplete,
			owner,
			prompt,
			repo,
			scheduleType,
			scheduleValue,
		],
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
					<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} required rows={6} />
				</div>
				<div className="form-row">
					<div className="form-group">
						<label>Schedule Type</label>
						<select
							value={scheduleType}
							onChange={(e) => setScheduleType(e.target.value as CronScheduleType)}
						>
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
					<input type="text" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
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
