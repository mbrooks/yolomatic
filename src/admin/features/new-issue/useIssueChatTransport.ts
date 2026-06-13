import { useCallback, useEffect, useRef, useState } from "react";
import { chatIssue, type IssueChatPayload, type IssueChatResponse } from "../../api/issues.js";
import { webSocketManager } from "../../api/websocket.js";

export function useIssueChatTransport(): {
	wsStatus: typeof webSocketManager.connectionStatus;
	progressMessage: string | null;
	setProgressMessage: (message: string | null) => void;
	submitIssueChat: (
		payload: IssueChatPayload,
		onThinking: (chunk: { text: string; done: boolean }) => void,
	) => Promise<IssueChatResponse>;
	abortIssueChat: () => void;
	steerIssueChat: (message: string) => void;
} {
	const [wsStatus, setWsStatus] = useState(webSocketManager.connectionStatus);
	const [progressMessage, setProgressMessage] = useState<string | null>(null);
	const currentRequestIdRef = useRef<string | null>(null);

	useEffect(() => {
		const unsubscribe = webSocketManager.onStatusChange(setWsStatus);
		const unsubStatus = webSocketManager.subscribeStatus(() => {
			// No-op: subscription keeps the connection alive.
		});
		return () => {
			unsubscribe();
			unsubStatus();
		};
	}, []);

	const submitIssueChat = useCallback(async (
		payload: IssueChatPayload,
		onThinking: (chunk: { text: string; done: boolean }) => void,
	): Promise<IssueChatResponse> => {
		setProgressMessage("Thinking through the issue draft...");
		let sawWebSocketProgress = false;
		if (wsStatus === "open") {
			try {
				const requestId = `issue-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				currentRequestIdRef.current = requestId;
				const response = await webSocketManager.requestIssueChat(requestId, payload, (event) => {
					sawWebSocketProgress = true;
					if (event.type === "thinking") {
						onThinking({ text: event.text ?? event.message, done: event.done ?? false });
						setProgressMessage(null);
						return;
					}
					setProgressMessage(event.message);
				});
				currentRequestIdRef.current = null;
				return response;
			} catch (error) {
				currentRequestIdRef.current = null;
				if (error instanceof Error && error.message === "Aborted") {
					throw error;
				}
				if (sawWebSocketProgress) {
					throw error;
				}
				setProgressMessage("Live connection failed. Retrying over HTTP...");
				return chatIssue(payload);
			}
		}
		return chatIssue(payload);
	}, [wsStatus]);

	const abortIssueChat = useCallback(() => {
		const requestId = currentRequestIdRef.current;
		if (requestId) {
			webSocketManager.abortIssueChat(requestId);
			currentRequestIdRef.current = null;
		}
	}, []);

	const steerIssueChat = useCallback((message: string) => {
		const requestId = currentRequestIdRef.current;
		if (requestId) {
			webSocketManager.steerIssueChat(requestId, message);
		}
	}, []);

	return {
		wsStatus,
		progressMessage,
		setProgressMessage,
		submitIssueChat,
		abortIssueChat,
		steerIssueChat,
	};
}
