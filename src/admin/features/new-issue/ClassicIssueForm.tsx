import React, { useState, useCallback } from "react";
import { createIssue, type CreateIssuePayload } from "../../api/issues.js";

export function ClassicIssueForm({
	prefillOwner,
	prefillRepo,
	onBack,
}: {
	prefillOwner?: string;
	prefillRepo?: string;
	onBack: () => void;
}): React.ReactElement {
	const [owner, setOwner] = useState(prefillOwner ?? "");
	const [repo, setRepo] = useState(prefillRepo ?? "");
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [labels, setLabels] = useState("");
	const [assignees, setAssignees] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [createdUrl, setCreatedUrl] = useState<string | null>(null);
	const [createdNumber, setCreatedNumber] = useState<number | null>(null);

	const handleSubmit = useCallback(async () => {
		setError(null);
		if (!owner.trim() || !repo.trim() || !title.trim()) {
			setError("Owner, repo, and title are required.");
			return;
		}
		setSubmitting(true);
		try {
			const payload: CreateIssuePayload = {
				owner: owner.trim(),
				repo: repo.trim(),
				title: title.trim(),
				body: body.trim(),
				labels: labels
					.split(",")
					.map((l) => l.trim())
					.filter(Boolean),
				assignees: assignees
					.split(",")
					.map((a) => a.trim())
					.filter(Boolean),
			};
			const result = await createIssue(payload);
			setCreatedUrl(result.html_url);
			setCreatedNumber(result.number);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(message);
		} finally {
			setSubmitting(false);
		}
	}, [owner, repo, title, body, labels, assignees]);

	if (createdUrl && createdNumber !== null) {
		return (
			<div className="classic-issue-form">
				<div className="form-success">
					Issue created: {" "}
					<a href={createdUrl} target="_blank" rel="noreferrer">
						#{createdNumber}
					</a>
				</div>
				<div className="form-actions">
					<button className="action-btn complete" type="button" onClick={() => {
						setCreatedUrl(null);
						setCreatedNumber(null);
						setTitle("");
						setBody("");
						setLabels("");
						setAssignees("");
					}}>
						Create another
					</button>
					<button className="action-btn" type="button" onClick={onBack}>Back</button>
				</div>
			</div>
		);
	}

	return (
		<div className="classic-issue-form">
			<div className="form-group">
				<label>Owner</label>
				<input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="e.g. mbrooks" />
			</div>
			<div className="form-group">
				<label>Repository</label>
				<input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="e.g. tars" />
			</div>
			<div className="form-group">
				<label>Title *</label>
				<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Issue title" />
			</div>
			<div className="form-group">
				<label>Description</label>
				<textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} placeholder="Detailed description..." />
			</div>
			<div className="form-group">
				<label>Labels (comma-separated)</label>
				<input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="bug, enhancement..." />
			</div>
			<div className="form-group">
				<label>Assignees (comma-separated)</label>
				<input value={assignees} onChange={(e) => setAssignees(e.target.value)} placeholder="username1, username2..." />
			</div>
			{error && <div className="form-error">{error}</div>}
			<div className="form-actions">
				<button className="action-btn complete" type="button" onClick={() => void handleSubmit()} disabled={submitting}>
					{submitting ? "Creating..." : "Create Issue"}
				</button>
				<button className="action-btn" type="button" onClick={onBack}>Back</button>
			</div>
		</div>
	);
}
