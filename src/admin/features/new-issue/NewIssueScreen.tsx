import React, { useCallback, useEffect, useRef, useState } from "react";
import { Breadcrumb } from "../../components/Breadcrumb.js";
import { createIssue, generateIssue, fetchRepoContext, type CreateIssuePayload } from "../../api/issues.js";
import { ClassicIssueForm } from "./ClassicIssueForm.js";
import {
	ChatTranscript,
	IssueReviewActions,
	PreviewCard,
	commaList,
	parseRepo,
	uid,
	type ChatMessage,
	type Phase,
} from "./chat.js";

export function NewIssueScreen({
	onBack,
	prefillOwner,
	prefillRepo,
}: {
	onBack: () => void;
	prefillOwner?: string;
	prefillRepo?: string;
}): React.ReactElement {
	const [messages, setMessages] = useState<ChatMessage[]>(() => {
		const initial: ChatMessage[] = [
			{ id: uid(), role: "tars", type: "text", text: "Which repository should I create the issue in?" },
		];
		return initial;
	});
	const [phase, setPhase] = useState<Phase>("repo");
	const [input, setInput] = useState("");
	const [error, setError] = useState<string | null>(null);

	const [owner, setOwner] = useState("");
	const [repo, setRepo] = useState("");
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [labels, setLabels] = useState<string[]>([]);
	const [assignees, setAssignees] = useState<string[]>([]);
	const [issueUrl, setIssueUrl] = useState<string | null>(null);
	const [issueNumber, setIssueNumber] = useState<number | null>(null);

	const [viewMode, setViewMode] = useState<"chat" | "classic">("chat");
	const [privacyMode, setPrivacyMode] = useState(false);
	const [repoContext, setRepoContext] = useState<import("../../api/issues.js").RepoContext | null>(null);
	const [selectedTemplate, setSelectedTemplate] = useState<string | undefined>(undefined);
	const [loadingContext, setLoadingContext] = useState(false);

	const messagesEndRef = useRef<HTMLDivElement | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);

	const scrollToBottom = useCallback(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, []);

	useEffect(() => {
		scrollToBottom();
	}, [messages, scrollToBottom]);

	useEffect(() => {
		inputRef.current?.focus();
	}, [phase]);

	useEffect(() => {
		if (owner && repo) {
			setLoadingContext(true);
			fetchRepoContext(owner, repo)
				.then((ctx) => {
					setRepoContext(ctx);
				})
				.catch(() => {
					setRepoContext(null);
				})
				.finally(() => {
					setLoadingContext(false);
				});
		}
	}, [owner, repo]);

	const appendMessage = useCallback((msg: ChatMessage) => {
		setMessages((prev) => [...prev, msg]);
	}, []);

	const handleReset = useCallback(() => {
		setMessages([
			{ id: uid(), role: "tars", type: "text", text: "Which repository should I create the issue in?" },
		]);
		setPhase("repo");
		setInput("");
		setError(null);
		setOwner("");
		setRepo("");
		setTitle("");
		setBody("");
		setLabels([]);
		setAssignees([]);
		setIssueUrl(null);
		setIssueNumber(null);
		setPrivacyMode(false);
		setRepoContext(null);
		setSelectedTemplate(undefined);
	}, []);

	const addPreview = useCallback(
		(
			t: string,
			b: string,
			l: string[],
			a: string[],
			introText?: string,
		) => {
			if (introText) {
				appendMessage({ id: uid(), role: "tars", type: "text", text: introText });
			}
			appendMessage({
				id: uid(),
				role: "tars",
				type: "preview",
				title: t,
				body: b,
				labels: l,
				assignees: a,
			});
		},
		[appendMessage],
	);

	const handleSubmit = useCallback(async () => {
		const value = input.trim();
		if (!value) return;
		setInput("");
		setError(null);
		appendMessage({ id: uid(), role: "user", type: "text", text: value });

		if (phase === "repo") {
			const parsed = parseRepo(value);
			if (!parsed) {
				setError("Repository must be in the format owner/repo.");
				appendMessage({
					id: uid(),
					role: "tars",
					type: "text",
					text: "That doesn't look like a valid repository. Please use the format owner/repo.",
				});
				return;
			}
			setOwner(parsed.owner);
			setRepo(parsed.repo);
			setPhase("prompt");
			appendMessage({
				id: uid(),
				role: "tars",
				type: "text",
				text: `Got it — ${parsed.owner}/${parsed.repo}. Now describe the issue in your own words and I'll draft the title and description.`,
			});
			return;
		}

		if (phase === "prompt") {
			if (!owner || !repo) return;
			setPhase("generating");
			try {
				const result = await generateIssue({
					owner,
					repo,
					prompt: value,
					privacyMode,
					selectedTemplate,
					context: repoContext ?? undefined,
				});
				setTitle(result.title);
				setBody(result.body);
				setLabels(result.labels);
				setAssignees(result.assignees);
				setPhase("review");
				addPreview(result.title, result.body, result.labels, result.assignees, "Here's a draft:");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				setError(`Generation failed: ${message}`);
				setPhase("prompt");
				appendMessage({
					id: uid(),
					role: "tars",
					type: "text",
					text: `I couldn't generate the issue: ${message}. Want to try again?`,
				});
			}
			return;
		}

		if (phase === "edit-title") {
			setTitle(value);
			setPhase("review");
			addPreview(value, body, labels, assignees, "Title updated. Here's the latest draft:");
			return;
		}

		if (phase === "edit-body") {
			setBody(value);
			setPhase("review");
			addPreview(title, value, labels, assignees, "Description updated. Here's the latest draft:");
			return;
		}

		if (phase === "edit-labels") {
			const list = commaList(value);
			setLabels(list);
			setPhase("review");
			addPreview(title, body, list, assignees, "Labels updated. Here's the latest draft:");
			return;
		}

		if (phase === "edit-assignees") {
			const list = commaList(value);
			setAssignees(list);
			setPhase("review");
			addPreview(title, body, labels, list, "Assignees updated. Here's the latest draft:");
			return;
		}
	}, [input, phase, owner, repo, body, labels, assignees, title, appendMessage, addPreview, privacyMode, selectedTemplate, repoContext]);

	const handleCreate = useCallback(async () => {
		if (!owner || !repo || !title.trim()) return;
		setError(null);
		setPhase("creating");
		try {
			const payload: CreateIssuePayload = {
				owner,
				repo,
				title: title.trim(),
				body: body.trim(),
				labels,
				assignees,
			};
			const result = await createIssue(payload);
			setIssueUrl(result.html_url);
			setIssueNumber(result.number);
			setPhase("done");
			appendMessage({
				id: uid(),
				role: "tars",
				type: "done",
				url: result.html_url,
				number: result.number,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(message);
			setPhase("review");
			appendMessage({
				id: uid(),
				role: "tars",
				type: "text",
				text: `Something went wrong while creating the issue: ${message}. You can try again or adjust the draft.`,
			});
		}
	}, [owner, repo, title, body, labels, assignees, appendMessage]);

	const askEdit = useCallback(
		(field: string, promptText: string) => {
			appendMessage({ id: uid(), role: "user", type: "text", text: `Edit ${field}` });
			if (field === "title") setPhase("edit-title");
			if (field === "description") setPhase("edit-body");
			if (field === "labels") setPhase("edit-labels");
			if (field === "assignees") setPhase("edit-assignees");
			appendMessage({ id: uid(), role: "tars", type: "text", text: promptText });
		},
		[appendMessage],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				void handleSubmit();
			}
		},
		[handleSubmit],
	);

	const isInputDisabled = phase === "generating" || phase === "creating" || phase === "done";
	const submitLabel =
		phase === "generating"
			? "Generating..."
			: phase === "creating"
				? "Creating..."
				: "Send";

	const showQuickRepo = phase === "repo" && prefillOwner && prefillRepo;

	const showTemplateSelector = phase === "prompt" && repoContext && repoContext.templates.length > 0;

	if (viewMode === "classic") {
	return (
		<div className="new-issue-screen">
			<Breadcrumb
				label="Create New Issue"
				onBack={onBack}
				onBackExtra={
					phase !== "repo"
						? {
							label: "Reset",
							onClick: handleReset,
					  }
						: undefined
				}
			/>
			<div className="new-issue-toolbar">
				<button
					className="chat-action-chip"
					type="button"
					onClick={() => setViewMode("chat")}
					title="Switch to chat"
				>
					Chat
				</button>
			</div>
			<ClassicIssueForm
				prefillOwner={prefillOwner}
				prefillRepo={prefillRepo}
				onBack={() => setViewMode("chat")}
			/>
		</div>
	);
	}

	return (
	<div className="new-issue-screen">
		<Breadcrumb
			label="Create New Issue"
			onBack={onBack}
			onBackExtra={
				phase !== "repo"
					? {
						label: "Reset",
						onClick: handleReset,
				  }
					: undefined
			}
		/>

		<div className="new-issue-toolbar">
			<button
				className="chat-action-chip"
				type="button"
				onClick={() => setViewMode(viewMode === "chat" ? "classic" : "chat")}
				title={viewMode === "chat" ? "Switch to classic form" : "Switch to chat"}
			>
				{viewMode === "chat" ? "Classic form" : "Chat"}
			</button>
			<label className="privacy-toggle" title="Exclude potentially sensitive content from LLM context">
				<input
					type="checkbox"
					checked={privacyMode}
					onChange={(e) => setPrivacyMode(e.target.checked)}
				/>
				Privacy mode
			</label>
			{loadingContext && <span className="context-loading">Loading repo context…</span>}
		</div>

		<div className="new-issue-workspace">
			<div className="chat-pane">
				<div className="chat-messages">
					<ChatTranscript
						messages={messages}
						showTyping={phase === "generating" || phase === "creating"}
					/>
					{phase === "review" && (
						<IssueReviewActions
							onCreate={() => void handleCreate()}
							onEdit={(field) =>
								askEdit(
									field,
									field === "title"
										? "What should the title be?"
										: field === "description"
											? "Paste the new description."
											: field === "labels"
												? "What labels should it have? (comma-separated)"
												: "Who should be assigned? (comma-separated)",
								)
							}
							onReset={handleReset}
						/>
					)}
					{phase === "done" && (
						<div className="chat-actions">
							<button className="chat-action-chip primary" type="button" onClick={handleReset}>
								Create another
							</button>
						</div>
					)}
					<div ref={messagesEndRef} />
				</div>

				{showQuickRepo && (
					<div className="chat-quick-actions">
						<button
							className="chat-action-chip"
							type="button"
							onClick={() => {
								const value = `${prefillOwner}/${prefillRepo}`;
								setInput("");
								setError(null);
								appendMessage({ id: uid(), role: "user", type: "text", text: value });
								setOwner(prefillOwner);
								setRepo(prefillRepo);
								setPhase("prompt");
								appendMessage({
									id: uid(),
									role: "tars",
									type: "text",
									text: `Got it — ${prefillOwner}/${prefillRepo}. Now describe the issue in your own words and I'll draft the title and description.`,
								});
							}}
						>
							Use {prefillOwner}/{prefillRepo}
						</button>
					</div>
				)}

				{showTemplateSelector && (
					<div className="template-selector">
						<span className="template-selector-label">Template:{" "}</span>
						<select
							value={selectedTemplate ?? ""}
							onChange={(e) => setSelectedTemplate(e.target.value || undefined)}
						>
							<option value="">None (auto-detect)</option>
							{repoContext!.templates.map((t) => (
								<option key={t.name} value={t.name}>{t.name}</option>
							))}
						</select>
					</div>
				)}

				{error && <div className="chat-error">{error}</div>}

				<div className="chat-input-row">
					<input
						ref={inputRef}
						className="chat-input"
						type="text"
						placeholder={
							phase === "repo"
								? "owner/repo"
									: phase === "prompt"
										? "Describe the issue..."
											: phase === "edit-title"
												? "New title..."
													: phase === "edit-body"
														? "New description..."
															: phase === "edit-labels"
																? "bug, enhancement..."
																	: phase === "edit-assignees"
																		? "username1, username2..."
																				: "Send"
						}
						value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={handleKeyDown}
							disabled={isInputDisabled}
						/>
						<button
							className="chat-send-btn"
							type="button"
							onClick={() => void handleSubmit()}
							disabled={isInputDisabled || !input.trim()}
						>
							{submitLabel}
						</button>
					</div>
				</div>

				<div className="preview-pane">
					<div className="preview-pane-header">Live Preview</div>
					<div className="preview-pane-body">
						<PreviewCard
							title={title || "(no title yet)"}
							body={body}
							labels={labels}
							assignees={assignees}
						/>
						{repoContext && repoContext.labels.length > 0 && (
							<div className="preview-context">
								<div className="preview-context-header">Available Labels</div>
								<div className="preview-context-tags">
									{repoContext.labels.map((l) => (
										<button
											key={l}
											className={`preview-context-tag${labels.includes(l) ? " active" : ""}`}
											type="button"
											onClick={() => {
												setLabels((prev) =>
													prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l],
												);
											}}
										>
											{l}
										</button>
									))}
								</div>
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
