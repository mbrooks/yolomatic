import React from "react";
import type { OpenIssue } from "../../api/issues.js";

export function IssueDetail({
	selected,
}: {
	selected: OpenIssue | null;
}): React.ReactElement {
	if (!selected) {
		return (
			<div className="detail-pane empty">
				Select an issue from the list to view details.
			</div>
		);
	}

	return (
		<div className="detail-pane">
			<div className="detail-title">
				<a href={selected.html_url} target="_blank" rel="noreferrer">
					#{selected.number} {selected.title}
				</a>
			</div>

			<div className="detail-section">
				<h3>Description</h3>
				{selected.body ? (
					<div className="issue-body">{selected.body}</div>
				) : (
					<div className="issue-body-empty">No description provided.</div>
				)}
			</div>

			<div className="detail-section">
				<h3>Assignees</h3>
				<div className="detail-row">
					{selected.assignees.length > 0 ? (
						selected.assignees.map((a) => (
							<span key={a} className="issue-tag assignee-tag">{a}</span>
						))
					) : (
						<span className="issue-body-empty">Unassigned</span>
					)}
				</div>
			</div>

			<div className="detail-section">
				<h3>Labels</h3>
				<div className="detail-row">
					{selected.labels.length > 0 ? (
						selected.labels.map((l) => (
							<span key={l} className="issue-tag label-tag">{l}</span>
						))
					) : (
						<span className="issue-body-empty">No labels</span>
					)}
				</div>
			</div>
		</div>
	);
}
