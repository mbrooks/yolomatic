import React, { useState, useCallback } from "react";
import type { OpenIssue } from "../../api/issues.js";
import { assignIssue } from "../../api/issues.js";

export function IssueDetail({
	selected,
	owner,
	repo,
	onAssignSuccess,
}: {
	selected: OpenIssue | null;
	owner: string;
	repo: string;
	onAssignSuccess?: () => void;
}): React.ReactElement {
	const [assigning, setAssigning] = useState(false);
	const [assignError, setAssignError] = useState<string | null>(null);

	const handleAssign = useCallback(async () => {
		if (!selected) return;
		setAssigning(true);
		setAssignError(null);
		try {
			await assignIssue(owner, repo, selected.number);
			onAssignSuccess?.();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setAssignError(message);
		} finally {
			setAssigning(false);
		}
	}, [selected, owner, repo, onAssignSuccess]);

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
					{selected.assignees.length === 0 && (
						<button
							className="action-btn"
							onClick={handleAssign}
							disabled={assigning}
							style={{ marginLeft: "0.5rem" }}
						>
							{assigning ? "Assigning..." : "Assign to TARS"}
						</button>
					)}
					{assignError && (
						<div className="form-error" style={{ marginTop: "0.25rem" }}>{assignError}</div>
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
