import { useCallback, useEffect, useState } from "react";
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
} {
	const [wsStatus, setWsStatus] = useState(webSocketManager.connectionStatus);
	const [progressMessage, setProgressMessage] = useState<string | null>(null);

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
				return await webSocketManager.requestIssueChat(payload, (event) => {
					sawWebSocketProgress = true;
					if (event.type === "thinking") {
						onThinking({ text: event.text ?? event.message, done: event.done ?? false });
						setProgressMessage(null);
						return;
					}
					setProgressMessage(event.message);
				});
			} catch (error) {
				if (sawWebSocketProgress) {
					throw error;
				}
				setProgressMessage("Live connection failed. Retrying over HTTP...");
				return chatIssue(payload);
			}
		}
		return chatIssue(payload);
	}, [wsStatus]);

	return {
		wsStatus,
		progressMessage,
		setProgressMessage,
		submitIssueChat,
	};
}
