import React, { useCallback, useEffect, useRef, useState } from "react";
import { Breadcrumb } from "../../components/Breadcrumb.js";
import { chatIssue, fetchRepoContext, type IssueDraft, type IssueChatMessage, type RepoContext } from "../../api/issues.js";
import { ChatTranscript, PreviewCard, uid, type ChatMessage } from "./chat.js";
import { webSocketManager } from "../../api/websocket.js";
import type { RepoSummary } from "../../app/types.js";

function hasDraftContent(draft: IssueDraft): boolean {
	return Boolean(
		draft.title.trim() ||
		draft.body.trim() ||
		draft.labels.length > 0 ||
		draft.assignees.length > 0,
	);
}

function toApiMessages(messages: Array<{ role: "tars" | "user"; type: "text"; text: string }>): IssueChatMessage[] {
	return messages.map((message) => ({
		role: message.role === "tars" ? "assistant" : "user",
		text: message.text,
	}));
}

export function NewIssueScreen({
	onBack,
	prefillOwner,
	prefillRepo,
	repos,
}: {
	onBack: () => void;
	prefillOwner?: string;
	prefillRepo?: string;
	repos?: RepoSummary[];
}): React.ReactElement {
	const initialOwner = prefillOwner ?? "";
	const initialRepo = prefillRepo ?? "";
	const initialPrompt = "What issue do you want to create?";

	const [messages, setMessages] = useState<Array<{ id: string; role: "tars" | "user"; type: "text"; text: string }>>([
		{ id: uid(), role: "tars", type: "text", text: initialPrompt },
	]);
	const [draft, setDraft] = useState<IssueDraft>({
		title: "",
		body: "",
		labels: [],
		assignees: [],
	});
	const [owner, setOwner] = useState(initialOwner);
	const [repo, setRepo] = useState(initialRepo);
	const [input, setInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [privacyMode, setPrivacyMode] = useState(false);
	const [repoContext, setRepoContext] = useState<RepoContext | null>(null);
	const [selectedTemplate, setSelectedTemplate] = useState<string | undefined>(undefined);
	const [loadingContext, setLoadingContext] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [createdIssue, setCreatedIssue] = useState<{ number: number; html_url: string } | null>(null);
	const [wsStatus, setWsStatus] = useState(webSocketManager.connectionStatus);

	const messagesEndRef = useRef<HTMLDivElement | null>(null);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);

	const scrollToBottom = useCallback(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, []);

	useEffect(() => {
		const unsubscribe = webSocketManager.onStatusChange(setWsStatus);
		// Ensure websocket is connected for real-time status
		const unsubStatus = webSocketManager.subscribeStatus(() => {
			// No-op: subscription keeps the connection alive
		});
		return () => {
			unsubscribe();
			unsubStatus();
		};
	}, []);

	useEffect(() => {
		scrollToBottom();
	}, [messages, scrollToBottom]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	useEffect(() => {
		if (!owner || !repo) {
			setRepoContext(null);
			return;
		}
		setLoadingContext(true);
		fetchRepoContext(owner, repo)
			.then((context) => {
				setRepoContext(context);
			})
			.catch(() => {
				setRepoContext(null);
			})
			.finally(() => {
				setLoadingContext(false);
			});
	}, [owner, repo]);

	const appendTextMessage = useCallback((role: "tars" | "user", text: string) => {
		setMessages((prev) => [...prev, { id: uid(), role, type: "text", text }]);
	}, []);

	const handleReset = useCallback(() => {
		setMessages([{ id: uid(), role: "tars", type: "text", text: initialPrompt }]);
		setDraft({ title: "", body: "", labels: [], assignees: [] });
		setOwner(initialOwner);
		setRepo(initialRepo);
		setInput("");
		setError(null);
		setPrivacyMode(false);
		setRepoContext(null);
		setSelectedTemplate(undefined);
		setSubmitting(false);
		setCreatedIssue(null);
	}, [initialOwner, initialPrompt, initialRepo]);

	const handleSubmit = useCallback(async () => {
		const value = input.trim();
		if (!value || submitting) {
			return;
		}

		const userMessage = { id: uid(), role: "user" as const, type: "text" as const, text: value };
		const nextMessages = [...messages, userMessage];

		setMessages(nextMessages);
		setInput("");
		setError(null);
		setSubmitting(true);

		try {
			const result = await chatIssue({
				owner: owner || undefined,
				repo: repo || undefined,
				draft,
				context: repoContext ?? undefined,
				privacyMode,
				selectedTemplate,
				messages: toApiMessages(nextMessages),
			});

			setOwner(result.owner);
			setRepo(result.repo);
			setDraft(result.draft);
			appendTextMessage("tars", result.message || "Issue draft updated.");

			if (result.createdIssue) {
				setCreatedIssue(result.createdIssue);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(message);
			appendTextMessage("tars", `I couldn't continue the issue draft: ${message}`);
		} finally {
			setSubmitting(false);
		}
	}, [appendTextMessage, draft, input, messages, owner, privacyMode, repo, repoContext, selectedTemplate, submitting]);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				void handleSubmit();
			}
		},
		[handleSubmit],
	);

	const transcriptMessages: ChatMessage[] = createdIssue
		? [...messages, { id: `done-${createdIssue.number}`, role: "tars", type: "done", url: createdIssue.html_url, number: createdIssue.number }]
		: messages;

	return (
		<div className="new-issue-screen">
			<Breadcrumb
				label="Create New Issue"
				onBack={onBack}
				onBackExtra={{
					label: "Reset",
					onClick: handleReset,
				}}
			/>

			<div className="new-issue-toolbar">
				<label className="privacy-toggle" title="Exclude potentially sensitive content from LLM context">
					<input
						type="checkbox"
						checked={privacyMode}
						onChange={(event) => setPrivacyMode(event.target.checked)}
					/>
					Privacy mode
				</label>
				{loadingContext ? <span className="context-loading">Loading repo context…</span> : null}
				<span className={`ws-status ws-status-${wsStatus}`} title={`WebSocket: ${wsStatus}`}>
					{wsStatus === "open" ? "● Live" : wsStatus === "connecting" ? "● Connecting…" : "● Offline"}
				</span>
				{createdIssue ? (
					<a className="issue-link" href={createdIssue.html_url} target="_blank" rel="noreferrer">
						Issue #{createdIssue.number}
					</a>
				) : null}
			</div>

			<div className="new-issue-workspace">
				<div className="chat-pane">
					<div className="chat-messages">
						<ChatTranscript messages={transcriptMessages} showTyping={submitting} />
						<div ref={messagesEndRef} />
					</div>

					{repoContext && repoContext.templates.length > 0 ? (
						<div className="template-selector">
							<span className="template-selector-label">Template:</span>
							<select
								value={selectedTemplate ?? ""}
								onChange={(event) => setSelectedTemplate(event.target.value || undefined)}
							>
								<option value="">None (auto-detect)</option>
								{repoContext.templates.map((template) => (
									<option key={template.name} value={template.name}>
										{template.name}
									</option>
								))}
							</select>
						</div>
					) : null}

					{createdIssue ? (
						<div className="chat-actions">
							<button className="chat-action-chip primary" type="button" onClick={handleReset}>
								Create another
							</button>
						</div>
					) : null}

					{error ? <div className="chat-error">{error}</div> : null}

					<div className="chat-input-row">
						<textarea
							ref={inputRef}
							className="chat-input chat-input-area"
							placeholder="Tell TARS what issue to create. Use Shift+Enter for a newline."
							value={input}
							onChange={(event) => setInput(event.target.value)}
							onKeyDown={handleKeyDown}
							disabled={submitting || createdIssue !== null}
							rows={3}
						/>
						<button
							className="chat-send-btn"
							type="button"
							onClick={() => void handleSubmit()}
							disabled={submitting || createdIssue !== null || !input.trim()}
						>
							{submitting ? "Thinking..." : "Send"}
						</button>
					</div>
				</div>

				<div className="preview-pane">
					<div className="preview-pane-header">Issue draft</div>
					<div className="preview-pane-body">
						<div className="preview-context">
							<div className="preview-context-header">Repository</div>
							<div className="preview-context-tags">
								<div className="repo-selector-fields">
									<input
										aria-label="Repository owner"
										placeholder="owner"
										value={owner}
										onChange={(event) => setOwner(event.target.value)}
									/>
									<span className="repo-selector-slash">/</span>
									<input
										aria-label="Repository name"
										placeholder="repo"
										value={repo}
										onChange={(event) => setRepo(event.target.value)}
									/>
								</div>
								{repos && repos.length > 0 ? (
									<div className="repo-quick-chips">
										{repos.map((r) => (
											<button
												key={`${r.owner}/${r.repo}`}
												type="button"
												className={`preview-context-tag ${owner === r.owner && repo === r.repo ? "active" : ""}`}
												onClick={() => {
													setOwner(r.owner);
													setRepo(r.repo);
												}}
											>
												{r.owner}/{r.repo}
											</button>
										))}
									</div>
								) : null}
							</div>
						</div>

						<div className="preview-context">
							<div className="preview-context-header">Status</div>
							<div className="preview-context-tags">
								<span className={`preview-context-tag ${hasDraftContent(draft) ? "active" : ""}`}>
									{createdIssue ? "Created" : hasDraftContent(draft) ? "Drafting" : "Waiting for details"}
								</span>
							</div>
						</div>

						<div className="preview-context">
							<div className="preview-context-header">Current draft</div>
							{hasDraftContent(draft) ? (
								<PreviewCard
									title={draft.title || "(title pending)"}
									body={draft.body}
									labels={draft.labels}
									assignees={draft.assignees}
								/>
							) : (
								<div className="new-issue-hint">
									The assistant will keep this draft updated as the conversation progresses.
								</div>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
