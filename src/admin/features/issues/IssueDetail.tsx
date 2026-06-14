import React, { useState, useCallback, useEffect, useRef } from "react";
import type { OpenIssue } from "../../api/issues.js";
import { assignIssue, startIssueSession, closeIssue, markIssueDoNotWork } from "../../api/issues.js";

export function IssueDetail({
	selected,
	owner,
	repo,
	onAssignSuccess,
	onStartSessionSuccess,
	onCloseSuccess,
	onMarkDoNotWorkSuccess,
}: {
	selected: OpenIssue | null;
	owner: string;
	repo: string;
	onAssignSuccess?: () => void;
	onStartSessionSuccess?: () => void;
	onCloseSuccess?: () => void;
	onMarkDoNotWorkSuccess?: () => void;
}): React.ReactElement {
	const [assigning, setAssigning] = useState(false);
	const [assignError, setAssignError] = useState<string | null>(null);
	const [justAssigned, setJustAssigned] = useState(false);
	const [startingSession, setStartingSession] = useState(false);
	const [startSessionError, setStartSessionError] = useState<string | null>(null);
	const [closing, setClosing] = useState(false);
	const [closeError, setCloseError] = useState<string | null>(null);
	const [markingDoNotWork, setMarkingDoNotWork] = useState(false);
	const [markDoNotWorkError, setMarkDoNotWorkError] = useState<string | null>(null);

	const selectedRef = useRef(selected);
	selectedRef.current = selected;

	useEffect(() => {
		setAssigning(false);
		setAssignError(null);
		setJustAssigned(false);
		setStartingSession(false);
		setStartSessionError(null);
	}, [selected?.number, selected?.assignees?.join(",")]);

	const handleAssign = useCallback(async () => {
		if (!selected) return;
		const currentNumber = selected.number;
		setAssigning(true);
		setAssignError(null);
		try {
			await assignIssue(owner, repo, currentNumber, selected.title, selected.body, selected.labels);
			if (selectedRef.current?.number === currentNumber) {
				setJustAssigned(true);
			}
			onAssignSuccess?.();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setAssignError(message);
			if (selectedRef.current?.number === currentNumber) {
				setAssigning(false);
			}
		}
	}, [selected, owner, repo, onAssignSuccess]);

	const handleStartSession = useCallback(async () => {
		if (!selected) return;
		setStartingSession(true);
		setStartSessionError(null);
		try {
			await startIssueSession(owner, repo, selected.number, selected.title, selected.body, selected.labels);
			onStartSessionSuccess?.();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setStartSessionError(message);
		} finally {
			setStartingSession(false);
		}
	}, [selected, owner, repo, onStartSessionSuccess]);

	const handleClose = useCallback(async () => {
		if (!selected) return;
		setClosing(true);
		setCloseError(null);
		try {
			await closeIssue(owner, repo, selected.number);
			onCloseSuccess?.();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setCloseError(message);
		} finally {
			setClosing(false);
		}
	}, [selected, owner, repo, onCloseSuccess]);

	const handleMarkDoNotWork = useCallback(async () => {
		if (!selected) return;
		setMarkingDoNotWork(true);
		setMarkDoNotWorkError(null);
		try {
			await markIssueDoNotWork(owner, repo, selected.number);
			onMarkDoNotWorkSuccess?.();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setMarkDoNotWorkError(message);
		} finally {
			setMarkingDoNotWork(false);
		}
	}, [selected, owner, repo, onMarkDoNotWorkSuccess]);

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
					{selected.assignees.length > 0 || justAssigned ? (
						<>
							{selected.assignees.map((a) => (
								<span key={a} className="issue-tag assignee-tag">{a}</span>
							))}
							{justAssigned && selected.assignees.length === 0 && (
								<span className="issue-tag assignee-tag">TARS</span>
							)}
						</>
					) : (
						<span className="issue-body-empty">Unassigned</span>
					)}
					{selected.assignees.length === 0 && !justAssigned && (
						<>
							<button
								className="action-btn"
								onClick={handleAssign}
								disabled={assigning}
								style={{ marginLeft: "0.5rem" }}
							>
								{assigning ? "Assigning..." : "Assign to TARS"}
							</button>
							<button
								className="action-btn"
								onClick={handleStartSession}
								disabled={startingSession}
								style={{ marginLeft: "0.5rem" }}
							>
								{startingSession ? "Starting..." : "Start Session"}
							</button>
						</>
					)}
					{assignError && (
						<div className="form-error" style={{ marginTop: "0.25rem" }}>{assignError}</div>
					)}
					{startSessionError && (
						<div className="form-error" style={{ marginTop: "0.25rem" }}>{startSessionError}</div>
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

			<div className="detail-section">
				<h3>Actions</h3>
				<div className="detail-row">
					<button
						className="action-btn"
						onClick={handleClose}
						disabled={closing}
					>
						{closing ? "Closing..." : "Close Issue"}
					</button>
					<button
						className="action-btn"
						onClick={handleMarkDoNotWork}
						disabled={markingDoNotWork}
						style={{ marginLeft: "0.5rem" }}
					>
						{markingDoNotWork ? "Marking..." : "Mark as Do Not Work"}
					</button>
					{closeError && (
						<div className="form-error" style={{ marginTop: "0.25rem" }}>{closeError}</div>
					)}
					{markDoNotWorkError && (
						<div className="form-error" style={{ marginTop: "0.25rem" }}>{markDoNotWorkError}</div>
					)}
				</div>
			</div>
		</div>
	);
}
