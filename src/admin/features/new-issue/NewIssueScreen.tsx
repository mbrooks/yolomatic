import React, { useCallback, useState } from "react";
import { Breadcrumb } from "../../components/Breadcrumb.js";
import { createIssue, generateIssue, type CreateIssuePayload } from "../../api/issues.js";

type Step = "prompt" | "review" | "creating" | "done";

function parseRepo(text: string): { owner: string; repo: string } | null {
	const parts = text.trim().split("/").filter(Boolean);
	if (parts.length === 2) {
		return { owner: parts[0], repo: parts[1] };
	}
	return null;
}

function commaList(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
}

function joinList(items: string[]): string {
	return items.join(", ");
}

export function NewIssueScreen({
	onBack,
	prefillOwner,
	prefillRepo,
}: {
	onBack: () => void;
	prefillOwner?: string;
	prefillRepo?: string;
}): React.ReactElement {
	const [step, setStep] = useState<Step>("prompt");
	const [repoInput, setRepoInput] = useState(prefillOwner && prefillRepo ? `${prefillOwner}/${prefillRepo}` : "");
	const [prompt, setPrompt] = useState("");
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [labels, setLabels] = useState("");
	const [assignees, setAssignees] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [issueUrl, setIssueUrl] = useState<string | null>(null);
	const [issueNumber, setIssueNumber] = useState<number | null>(null);
	const [generationLoading, setGenerationLoading] = useState(false);

	const reset = useCallback(() => {
		setStep("prompt");
		setRepoInput("");
		setPrompt("");
		setTitle("");
		setBody("");
		setLabels("");
		setAssignees("");
		setError(null);
		setIssueUrl(null);
		setIssueNumber(null);
		setGenerationLoading(false);
	}, []);

	const handleGenerate = useCallback(async () => {
		setError(null);
		const parsed = parseRepo(repoInput);
		if (!parsed) {
			setError("Repository must be in the format owner/repo.");
			return;
		}
		if (!prompt.trim()) {
			setError("Please describe the issue you want to create.");
			return;
		}
		setGenerationLoading(true);
		try {
			const result = await generateIssue({ owner: parsed.owner, repo: parsed.repo, prompt: prompt.trim() });
			setTitle(result.title);
			setBody(result.body);
			setLabels(joinList(result.labels));
			setAssignees(joinList(result.assignees));
			setStep("review");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(`Generation failed: ${message}`);
		} finally {
			setGenerationLoading(false);
		}
	}, [repoInput, prompt]);

	const handleCreate = useCallback(async () => {
		setError(null);
		const parsed = parseRepo(repoInput);
		if (!parsed) {
			setError("Invalid repository format.");
			return;
		}
		if (!title.trim()) {
			setError("Title is required.");
			return;
		}
		setStep("creating");
		try {
			const payload: CreateIssuePayload = {
				owner: parsed.owner,
				repo: parsed.repo,
				title: title.trim(),
				body: body.trim(),
				labels: commaList(labels),
				assignees: commaList(assignees),
			};
			const result = await createIssue(payload);
			setIssueUrl(result.html_url);
			setIssueNumber(result.number);
			setStep("done");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(message);
			setStep("review");
		}
	}, [repoInput, title, body, labels, assignees]);

	return (
		<div className="new-issue-screen">
			<Breadcrumb label="Create New Issue" onBack={onBack} />
			<div className="new-issue-hint">
				Describe the issue in natural language and TARS will generate the title,
				description, labels, and assignees using the configured LLM.
			</div>

			<div className="chat-header">
				<span className="chat-title">TARS — Create New Issue</span>
				{step === "done" && issueUrl && (
					<a href={issueUrl} target="_blank" rel="noreferrer" className="issue-link">
						#{issueNumber}
					</a>
				)}
			</div>

			{error && <div className="chat-error">{error}</div>}

			{step === "prompt" && (
				<div className="form-group" style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
					<div className="form-group">
						<label htmlFor="repo">Repository</label>
						<input
							id="repo"
							type="text"
							placeholder="owner/repo"
							value={repoInput}
							onChange={(e) => setRepoInput(e.target.value)}
							disabled={generationLoading}
						/>
					</div>
					<div className="form-group">
						<label htmlFor="prompt">Describe the issue</label>
						<textarea
							id="prompt"
							placeholder="e.g. Refactor the auth middleware to use JWT tokens instead of session cookies..."
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							rows={8}
							disabled={generationLoading}
							style={{ resize: "vertical" }}
						/>
					</div>
					<div style={{ display: "flex", gap: "0.5rem" }}>
						<button
							className="chat-send-btn"
							type="button"
							onClick={() => void handleGenerate()}
							disabled={generationLoading || !repoInput.trim() || !prompt.trim()}
						>
							{generationLoading ? "Generating..." : "Generate Issue"}
						</button>
					</div>
				</div>
			)}

			{step === "review" && (
				<div className="form-group" style={{ display: "flex", flexDirection: "column", gap: "0.75rem", flex: 1, minHeight: 0 }}>
					<div className="form-row">
						<div className="form-group" style={{ flex: 1 }}>
							<label htmlFor="title">Title</label>
							<input
								id="title"
								type="text"
								value={title}
								onChange={(e) => setTitle(e.target.value)}
							/>
						</div>
					</div>
					<div className="form-group" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
						<label htmlFor="body">Description</label>
						<textarea
							id="body"
							value={body}
							onChange={(e) => setBody(e.target.value)}
							rows={12}
							style={{ resize: "vertical", flex: 1, minHeight: "8rem" }}
						/>
					</div>
					<div className="form-row">
						<div className="form-group" style={{ flex: 1 }}>
							<label htmlFor="labels">Labels (comma-separated)</label>
							<input
								id="labels"
								type="text"
								placeholder="bug, enhancement"
								value={labels}
								onChange={(e) => setLabels(e.target.value)}
							/>
						</div>
						<div className="form-group" style={{ flex: 1 }}>
							<label htmlFor="assignees">Assignees (comma-separated)</label>
							<input
								id="assignees"
								type="text"
								placeholder="username1, username2"
								value={assignees}
								onChange={(e) => setAssignees(e.target.value)}
							/>
						</div>
					</div>
					<div style={{ display: "flex", gap: "0.5rem", flexShrink: 0 }}>
						<button
							className="chat-send-btn"
							type="button"
							onClick={() => void handleCreate()}
						>
							Create Issue
						</button>
						<button
							className="chat-send-btn"
							style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }}
							type="button"
							onClick={() => setStep("prompt")}
						>
							Back
						</button>
					</div>
				</div>
			)}

			{step === "creating" && (
				<div className="chat-bubble tars" style={{ alignSelf: "flex-start" }}>
					<div className="chat-sender">TARS</div>
					<div className="chat-text">Creating issue...</div>
				</div>
			)}

			{step === "done" && (
				<div className="form-group" style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
					<div className="chat-bubble tars" style={{ alignSelf: "flex-start" }}>
						<div className="chat-sender">TARS</div>
						<div className="chat-text">
							Issue created successfully:{" "}
							<a href={issueUrl ?? undefined} target="_blank" rel="noreferrer">
								#{issueNumber}
							</a>
						</div>
					</div>
					<button className="chat-send-btn" type="button" onClick={reset}>
						Create Another
					</button>
				</div>
			)}
		</div>
	);
}
