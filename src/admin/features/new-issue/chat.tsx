import React from "react";

export type ChatMessage =
	| { id: string; role: "tars"; type: "text"; text: string }
	| { id: string; role: "user"; type: "text"; text: string }
	| { id: string; role: "tars"; type: "thinking"; text: string; done: boolean }
	| { id: string; role: "tars"; type: "done"; url: string; number: number };

export function uid(): string {
	return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function parseRepo(text: string): { owner: string; repo: string } | null {
	const parts = text.trim().split("/").filter(Boolean);
	return parts.length === 2 ? { owner: parts[0], repo: parts[1] } : null;
}

export function commaList(text: string): string[] {
	return text
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

export function joinList(items: string[]): string {
	return items.join(", ");
}

export function ChatTypingBubble(): React.ReactElement {
	return (
		<div className="chat-bubble tars chat-typing-bubble">
			<div className="chat-sender">TARS</div>
			<div className="chat-typing">
				<span />
				<span />
				<span />
			</div>
		</div>
	);
}

export function PreviewCard({
	title,
	body,
	labels,
	assignees,
}: {
	title: string;
	body: string;
	labels: string[];
	assignees: string[];
}): React.ReactElement {
	return (
		<div className="chat-preview-card">
			<div className="chat-preview-title">{title}</div>
			{body ? <div className="chat-preview-body">{body}</div> : null}
			{labels.length > 0 || assignees.length > 0 ? (
				<div className="chat-preview-meta">
					{labels.length > 0 ? (
						<div className="chat-preview-meta-row">
							<span className="chat-preview-meta-label">Labels</span>
							<span className="chat-preview-meta-value">{joinList(labels)}</span>
						</div>
					) : null}
					{assignees.length > 0 ? (
						<div className="chat-preview-meta-row">
							<span className="chat-preview-meta-label">Assignees</span>
							<span className="chat-preview-meta-value">{joinList(assignees)}</span>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}

export function ChatTranscript({
	messages,
	showTyping,
}: {
	messages: ChatMessage[];
	showTyping: boolean;
}): React.ReactElement {
	return (
		<>
			{messages.map((msg) => {
				if (msg.type === "text") {
					return (
						<div key={msg.id} className={`chat-bubble ${msg.role}`}>
							<div className="chat-sender">{msg.role === "tars" ? "TARS" : "You"}</div>
							<div className="chat-text">{msg.text}</div>
						</div>
					);
				}
				if (msg.type === "thinking") {
					return (
						<div key={msg.id} className="chat-bubble tars thinking">
							<div className="chat-sender">TARS thinking</div>
							<div className="chat-thinking-text">
								{msg.text}
								{msg.done ? null : <span className="chat-thinking-cursor">▊</span>}
							</div>
						</div>
					);
				}
				return (
					<div key={msg.id} className="chat-bubble tars">
						<div className="chat-sender">TARS</div>
						<div className="chat-text">
							Issue created:{" "}
							<a href={msg.url} target="_blank" rel="noreferrer">
								#{msg.number}
							</a>
						</div>
					</div>
				);
			})}
			{showTyping ? <ChatTypingBubble /> : null}
		</>
	);
}
