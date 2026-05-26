import React from "react";

export type ChatRole = "tars" | "user";

export type ChatMessage =
	| { id: string; role: "tars"; type: "text"; text: string }
	| { id: string; role: "user"; type: "text"; text: string }
	| {
			id: string;
			role: "tars";
			type: "preview";
			title: string;
			body: string;
			labels: string[];
			assignees: string[];
	  }
	| { id: string; role: "tars"; type: "done"; url: string; number: number }
	| {
			id: string;
			role: "tars";
			type: "suggestion";
			suggestionType: "title" | "labels";
			value: string;
			original: string;
	  };

export type Phase =
	| "repo"
	| "prompt"
	| "generating"
	| "review"
	| "edit-title"
	| "edit-body"
	| "edit-labels"
	| "edit-assignees"
	| "creating"
	| "done";

export type ViewMode = "chat" | "classic";

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

export function SuggestionChip({
	label,
	onAccept,
	onReject,
}: {
	label: string;
	onAccept: () => void;
	onReject: () => void;
}): React.ReactElement {
	return (
		<div className="chat-suggestion-chip">
			<span className="chat-suggestion-text">{label}</span>
			<button className="chat-suggestion-btn accept" type="button" onClick={onAccept}>✓</button>
			<button className="chat-suggestion-btn reject" type="button" onClick={onReject}>✕</button>
		</div>
	);
}

export function ChatTranscript({
	messages,
	showTyping,
	onAcceptSuggestion,
	onRejectSuggestion,
}: {
	messages: ChatMessage[];
	showTyping: boolean;
	onAcceptSuggestion?: (id: string) => void;
	onRejectSuggestion?: (id: string) => void;
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
				if (msg.type === "preview") {
					return (
						<div key={msg.id} className="chat-bubble tars">
							<div className="chat-sender">TARS</div>
							<PreviewCard
								title={msg.title}
								body={msg.body}
								labels={msg.labels}
								assignees={msg.assignees}
							/>
						</div>
					);
				}
				if (msg.type === "suggestion") {
					return (
						<div key={msg.id} className="chat-bubble tars">
							<div className="chat-sender">TARS</div>
							<div className="chat-text">
								{msg.suggestionType === "title" ? "Suggested title:" : "Suggested labels:"}{" "}
								<SuggestionChip
									label={msg.value}
									onAccept={() => onAcceptSuggestion?.(msg.id)}
									onReject={() => onRejectSuggestion?.(msg.id)}
								/>
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

export function IssueReviewActions({
	onCreate,
	onEdit,
	onReset,
}: {
	onCreate: () => void;
	onEdit: (field: "title" | "description" | "labels" | "assignees") => void;
	onReset: () => void;
}): React.ReactElement {
	return (
		<div className="chat-actions">
			<button className="chat-action-chip primary" type="button" onClick={onCreate}>
				Looks good - create it
			</button>
			<button className="chat-action-chip" type="button" onClick={() => onEdit("title")}>
				Edit title
			</button>
			<button className="chat-action-chip" type="button" onClick={() => onEdit("description")}>
				Edit description
			</button>
			<button className="chat-action-chip" type="button" onClick={() => onEdit("labels")}>
				Edit labels
			</button>
			<button className="chat-action-chip" type="button" onClick={() => onEdit("assignees")}>
				Edit assignees
			</button>
			<button className="chat-action-chip" type="button" onClick={onReset}>
				Start over
			</button>
		</div>
	);
}
