import React, { useCallback, useEffect, useRef, useState } from "react";
import { Breadcrumb } from "../../components/Breadcrumb.js";
import { type IssueChatMessage, type IssueChatPayload } from "../../api/issues.js";
import { ChatTranscript, PreviewCard, uid, type ChatMessage } from "./chat.js";
import { hasDraftContent, useNewIssueDraft } from "./useNewIssueDraft.js";
import { useIssueChatTransport } from "./useIssueChatTransport.js";
import { useRepoContext } from "./useRepoContext.js";
import type { RepoSummary } from "../../app/types.js";

function RepoSelectorStep({
	repos,
	onSelect,
}: {
	repos: RepoSummary[];
	onSelect: (owner: string, repo: string) => void;
}): React.ReactElement {
	const [manualOwner, setManualOwner] = useState("");
	const [manualRepo, setManualRepo] = useState("");

	const canContinue = Boolean(manualOwner.trim() && manualRepo.trim());

	return (
		<div className="repo-selector-step">
			<h2 className="repo-selector-title">Select a repository</h2>
			<p className="repo-selector-hint">Choose the repository where the new issue should be created.</p>

			{repos.length > 0 ? (
				<div className="repo-selector-grid">
					{repos.map((r) => (
						<button
							key={`${r.owner}/${r.repo}`}
							type="button"
							className="repo-selector-card"
							onClick={() => onSelect(r.owner, r.repo)}
						>
							<div className="repo-selector-card-name">
								{r.owner}/{r.repo}
							</div>
							<div className="repo-selector-card-meta">
								{r.activeCount} active · {r.sessionCount} sessions
							</div>
						</button>
					))}
				</div>
			) : (
				<div className="repo-selector-empty">No repositories have been configured yet.</div>
			)}

			<div className="repo-selector-manual">
				<div className="repo-selector-manual-label">Or enter a repository manually</div>
				<div className="repo-selector-manual-fields">
					<input
						aria-label="Repository owner"
						placeholder="owner"
						value={manualOwner}
						onChange={(e) => setManualOwner(e.target.value)}
					/>
					<span className="repo-selector-slash">/</span>
					<input
						aria-label="Repository name"
						placeholder="repo"
						value={manualRepo}
						onChange={(e) => setManualRepo(e.target.value)}
					/>
					<button
						type="button"
						className="chat-send-btn"
						disabled={!canContinue}
						onClick={() => onSelect(manualOwner.trim(), manualRepo.trim())}
					>
						Continue
					</button>
				</div>
			</div>
		</div>
	);
}

function toApiMessages(messages: ChatMessage[]): IssueChatMessage[] {
	return messages
		.filter((message): message is Extract<ChatMessage, { type: "text" }> => message.type === "text")
		.map((message) => ({
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

	const [messages, setMessages] = useState<ChatMessage[]>([
		{ id: uid(), role: "tars", type: "text", text: initialPrompt },
	]);
	const [repoSelected, setRepoSelected] = useState(() => Boolean(initialOwner && initialRepo));
	const [input, setInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [privacyMode, setPrivacyMode] = useState(false);
	const [submitting, setSubmitting] = useState(false);

	const messagesEndRef = useRef<HTMLDivElement | null>(null);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);

	const scrollToBottom = useCallback(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, []);

	useEffect(() => {
		scrollToBottom();
	}, [messages, scrollToBottom]);

	useEffect(() => {
		if (repoSelected) {
			inputRef.current?.focus();
		}
	}, [repoSelected]);

	const appendTextMessage = useCallback((role: "tars" | "user", text: string) => {
		setMessages((prev) => [...prev, { id: uid(), role, type: "text", text }]);
	}, []);
	const handleAssistantMessage = useCallback((message: string) => {
		appendTextMessage("tars", message);
	}, [appendTextMessage]);

	const {
		owner,
		setOwner,
		repo,
		setRepo,
		draft,
		setDraft,
		creatingIssue,
		createdIssue,
		setCreatedIssue,
		resetDraft,
		createCurrentIssue,
	} = useNewIssueDraft({
		initialOwner,
		initialRepo,
		onAssistantMessage: handleAssistantMessage,
	});
	const {
		repoContext,
		loadingContext,
		selectedTemplate,
		setSelectedTemplate,
		clearRepoContext,
		skills,
		loadingSkills,
	} = useRepoContext(owner, repo);
	const {
		wsStatus,
		progressMessage,
		setProgressMessage,
		submitIssueChat,
	} = useIssueChatTransport();

	useEffect(() => {
		if (!repoSelected && !owner && !repo && repos && repos.length === 1) {
			setOwner(repos[0].owner);
			setRepo(repos[0].repo);
			setRepoSelected(true);
		}
	}, [repoSelected, owner, repo, repos, setOwner, setRepo]);

	const appendThinkingMessage = useCallback((text: string, done: boolean) => {
		if (!text) {
			return;
		}
		setMessages((prev) => {
			const last = prev.at(-1);
			if (last?.type !== "thinking") {
				return [...prev, { id: uid(), role: "tars", type: "thinking", text, done }];
			}
			const nextText = done && text.startsWith(last.text) ? text : last.text + text;
			return [
				...prev.slice(0, -1),
				{ ...last, text: nextText, done },
			];
		});
	}, []);

	const applyChatResult = useCallback((result: Awaited<ReturnType<typeof submitIssueChat>>) => {
		setOwner(result.owner);
		setRepo(result.repo);
		setDraft(result.draft);
		appendTextMessage("tars", result.message || "Issue draft updated.");

		if (result.createdIssue) {
			setCreatedIssue(result.createdIssue);
		}
	}, [appendTextMessage]);

	const handleReset = useCallback(() => {
		setMessages([{ id: uid(), role: "tars", type: "text", text: initialPrompt }]);
		resetDraft();
		// Preserve the selected repository across resets
		setInput("");
		setError(null);
		setPrivacyMode(false);
		clearRepoContext();
		setSubmitting(false);
		setProgressMessage(null);
	}, [clearRepoContext, initialPrompt, resetDraft, setProgressMessage]);

	const handleSelectRepo = useCallback((selectedOwner: string, selectedRepoName: string) => {
		setOwner(selectedOwner);
		setRepo(selectedRepoName);
		setRepoSelected(true);
	}, []);

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
		setProgressMessage("Thinking through the issue draft...");

		const payload: IssueChatPayload = {
			owner: owner || undefined,
			repo: repo || undefined,
			draft,
			context: repoContext ?? undefined,
			privacyMode,
			selectedTemplate,
			messages: toApiMessages(nextMessages),
		};

		try {
			const result = await submitIssueChat(payload, (chunk) => {
				appendThinkingMessage(chunk.text, chunk.done);
			});
			applyChatResult(result);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(message);
			appendTextMessage("tars", `I couldn't continue the issue draft: ${message}`);
		} finally {
			setProgressMessage(null);
			setSubmitting(false);
		}
	}, [appendTextMessage, appendThinkingMessage, applyChatResult, draft, input, messages, owner, privacyMode, repo, repoContext, selectedTemplate, setProgressMessage, submitIssueChat, submitting]);

	const handleCreateIssue = useCallback(async () => {
		setError(null);
		const errorMessage = await createCurrentIssue();
		if (errorMessage) {
			setError(errorMessage);
		}
	}, [createCurrentIssue]);

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
	const lastTranscriptMessage = transcriptMessages.at(-1);
	const showTyping = submitting && lastTranscriptMessage?.type !== "thinking";

	if (!repoSelected) {
		return (
			<div className="new-issue-screen">
				<Breadcrumb label="Create New Issue" onBack={onBack} />
				<RepoSelectorStep repos={repos ?? []} onSelect={handleSelectRepo} />
			</div>
		);
	}

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
								<>
									<PreviewCard
										title={draft.title || "(title pending)"}
										body={draft.body}
										labels={draft.labels}
										assignees={draft.assignees}
									/>
									{!createdIssue ? (
										<button
											type="button"
											className="create-issue-btn"
											onClick={() => void handleCreateIssue()}
											disabled={creatingIssue || !draft.title.trim()}
										>
											{creatingIssue ? "Creating..." : "Create Issue"}
										</button>
									) : null}
									{creatingIssue ? <div className="context-loading">Creating issue...</div> : null}
								</>
							) : (
								<div className="new-issue-hint">
									The assistant will keep this draft updated as the conversation progresses.
								</div>
							)}
						</div>
					</div>
				</div>

				<div className="chat-pane">
					<div className="chat-messages">
						<ChatTranscript messages={transcriptMessages} showTyping={showTyping} />
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

					{skills.length > 0 ? (
						<div className="template-selector">
							<span className="template-selector-label">Skills:</span>
							{skills.map((skill) => (
								<span key={skill.name} className="preview-context-tag">
									{skill.name}
								</span>
							))}
						</div>
					) : null}
					{loadingSkills ? <div className="context-loading">Loading skills…</div> : null}

					{createdIssue ? (
						<div className="chat-actions">
							<button className="chat-action-chip primary" type="button" onClick={handleReset}>
								Create another
							</button>
						</div>
					) : null}

					{error ? <div className="chat-error">{error}</div> : null}
					{progressMessage ? <div className="context-loading">{progressMessage}</div> : null}

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
			</div>
		</div>
	);
}
