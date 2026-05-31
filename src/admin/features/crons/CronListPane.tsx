import React from "react";
import { formatRelative } from "../../lib/format.js";
import type { CronJob } from "../../app/types.js";

export function CronListPane({
	crons,
	selectedCron,
	onSelect,
	onCreate,
}: {
	crons: CronJob[];
	selectedCron: CronJob | null;
	onSelect: (cron: CronJob) => void;
	onCreate: () => void;
}): React.ReactElement {
	return (
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
							onClick={() => onSelect(cron)}
							tabIndex={0}
							role="button"
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									onSelect(cron);
								}
							}}
						>
							<div className="list-col cron-name">
								{cron.name}
								{cron.enabled ? null : <span className="cron-paused-badge">paused</span>}
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
			<button className="action-btn restart new-cron-btn" onClick={onCreate} type="button">
				+ New Cron Job
			</button>
		</div>
	);
}
