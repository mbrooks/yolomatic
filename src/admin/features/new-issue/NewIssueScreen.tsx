import React, { useCallback, useEffect, useRef, useState } from "react";
import { Breadcrumb } from "../../components/Breadcrumb.js";
import { createIssue, type CreateIssuePayload } from "../../api/issues.js";

type ChatRole = "user" | "tars";

interface ChatMessage {
	role: ChatRole;
	text: string;
}

interface IssueDraft {
	owner: string;
	repo: string;
	title: string;
	body: string;
	labels: string[];
	assignees: string[];
}

type Step = "repo" | "title" | "body" | "labels" | "assignees" | "confirm" | "creating" | "done";

const WELCOME_MESSAGE = "Hello. I'm TARS. I can create a new GitHub issue for you. Which repository should I create it in? (format: owner/repo)";

export function NewIssueScreen({
	onBack,
}: {
	onBack: () => void;
}): React.ReactElement {
	const [messages, setMessages] = useState<ChatMessage[]>([{ role: "tars", text: WELCOME_MESSAGE }]);
	const [input, setInput] = useState("");
	const [step, setStep] = useState<Step>("repo");
	const [draft, setDraft] = useState<Partial<IssueDraft>>({ labels: [], assignees: [] });
	const [error, setError] = useState<string | null>(null);
	const [issueUrl, setIssueUrl] = useState<string | null>(null);
	const [issueNumber, setIssueNumber] = useState<number | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const resetChat = useCallback(() => {
		setMessages([{ role: "tars", text: WELCOME_MESSAGE }]);
		setInput("");
		setStep("repo");
		setDraft({ labels: [], assignees: [] });
		setError(null);
		setIssueUrl(null);
		setIssueNumber(null);
	}, []);

	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [messages]);

	useEffect(() => {
		inputRef.current?.focus();
	}, [step]);

	const addMessage = useCallback((role: ChatRole, text: string) => {
		setMessages((prev) => [...prev, { role, text }]);
	}, []);

	const parseRepo = useCallback((text: string): { owner: string; repo: string } | null => {
		const parts = text.trim().split("/").filter(Boolean);
		if (parts.length === 2) {
			return { owner: parts[0], repo: parts[1] };
		}
		return null;
	}, []);

	const parseCommaList = useCallback((text: string): string[] => {
		const trimmed = text.trim();
		if (!trimmed || trimmed.toLowerCase() === "none") return [];
		return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
	}, []);

	const handleSend = useCallback(async () => {
		const text = input.trim();
		if (!text) return;
		setInput("");
		setError(null);
		addMessage("user", text);

		if (step === "repo") {
			const parsed = parseRepo(text);
			if (!parsed) {
				addMessage("tars", "I need the repository in the format `owner/repo`. Please try again.");
				return;
			}
			setDraft((d) => ({ ...d, owner: parsed.owner, repo: parsed.repo }));
			setStep("title");
			setTimeout(() => {
				addMessage("tars", `Got it. Creating an issue in **${parsed.owner}/${parsed.repo}**. What's the title?`);
			}, 200);
			return;
		}

		if (step === "title") {
			setDraft((d) => ({ ...d, title: text }));
			setStep("body");
			setTimeout(() => {
				addMessage("tars", "What's the description for this issue?");
			}, 200);
			return;
		}

		if (step === "body") {
			setDraft((d) => ({ ...d, body: text }));
			setStep("labels");
			setTimeout(() => {
				addMessage("tars", "Any labels? (comma-separated, or type `none` to skip)");
			}, 200);
			return;
		}

		if (step === "labels") {
			const labels = parseCommaList(text);
			setDraft((d) => ({ ...d, labels }));
			setStep("assignees");
			setTimeout(() => {
				addMessage("tars", "Any assignees? (comma-separated GitHub usernames, or type `none` to skip)");
			}, 200);
			return;
		}

		if (step === "assignees") {
			const assignees = parseCommaList(text);
			setDraft((d) => ({ ...d, assignees }));
			setStep("confirm");
			setTimeout(() => {
				const currentDraft = { ...draft, assignees };
				const lines = [
					"Here's what I'll create:",
					"",
					`**Repository:** ${currentDraft.owner}/${currentDraft.repo}`,
					`**Title:** ${currentDraft.title}`,
					`**Description:** ${currentDraft.body || "(empty)"}`,
					`**Labels:** ${currentDraft.labels?.length ? currentDraft.labels.join(", ") : "none"}`,
					`**Assignees:** ${currentDraft.assignees?.length ? currentDraft.assignees.join(", ") : "none"}`,
					"",
					"Type **yes** to create this issue, or **no** to cancel.",
				];
				addMessage("tars", lines.join("\n"));
			}, 200);
			return;
		}

		if (step === "confirm") {
			if (text.toLowerCase() !== "yes") {
				addMessage("tars", "Cancelled. Refreshing...");
				setTimeout(() => resetChat(), 1500);
				return;
			}
			setStep("creating");
			addMessage("tars", "Creating issue...");

			try {
				const payload: CreateIssuePayload = {
					owner: draft.owner!,
					repo: draft.repo!,
					title: draft.title!,
					body: draft.body || "",
					labels: draft.labels,
					assignees: draft.assignees,
				};
				const result = await createIssue(payload);
				setIssueUrl(result.html_url);
				setIssueNumber(result.number);
				setStep("done");
				addMessage(
					"tars",
					`Issue created successfully: [#${result.number}](${result.html_url})\n\nThis chat will reset shortly.`,
				);
				setTimeout(() => resetChat(), 4000);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				setError(message);
				setStep("confirm");
				addMessage("tars", `Failed to create issue: ${message}. Type **yes** to try again, or **no** to cancel.`);
			}
		}
	}, [step, input, draft, addMessage, parseRepo, parseCommaList, resetChat]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				void handleSend();
			}
		},
		[handleSend],);

	return (
		<div className="new-issue-screen">
			<Breadcrumb label="Create New Issue" onBack={onBack} />
			<div className="new-issue-hint">
				TARS will guide you through creating a GitHub issue. Have the repository
				owner/name ready, along with the title and description.
			</div>
			<div className="chat-header">
				<span className="chat-title">TARS — Create New Issue</span>
				{step === "done" && issueUrl && (
					<a href={issueUrl} target="_blank" rel="noreferrer" className="issue-link">
						#{issueNumber}
					</a>
				)}
			</div>

			<div ref={scrollRef} className="chat-messages">
				{messages.map((msg, i) => (
					<div key={i} className={`chat-bubble ${msg.role}`}>
						<div className="chat-sender">{msg.role === "tars" ? "TARS" : "You"}</div>
						<div className="chat-text">{msg.text}</div>
					</div>
				))}
			</div>

			{error && (
				<div className="chat-error">{error}</div>
			)}

			<div className="chat-input-row">
				<input
					ref={inputRef}
					type="text"
					className="chat-input"
					placeholder={step === "creating" ? "Creating..." : "Type your message..."}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					disabled={step === "creating" || step === "done"}
				/>
				<button
					className="chat-send-btn"
					onClick={() => void handleSend()}
					disabled={step === "creating" || step === "done" || !input.trim()}
					type="button"
				>
					Send
				</button>
			</div>
		</div>
	);
}
