import type { LogEntry } from "../app/types.js";

export type WebSocketStatus = "connecting" | "open" | "closed" | "error";

export interface StatusMessage {
	type: "status";
	data: unknown;
}

export interface LogMessage {
	type: "log-entry";
	sessionKey: string;
	entry: LogEntry;
}

type ServerMessage = StatusMessage | LogMessage | { type: "error"; message: string };

type LogCallback = (entry: LogEntry) => void;
type StatusCallback = (data: unknown) => void;

class WebSocketManager {
	private ws: WebSocket | null = null;
	private reconnectDelay = 1000;
	private readonly maxReconnectDelay = 30000;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private logListeners = new Map<string, Set<LogCallback>>();
	private statusListeners = new Set<StatusCallback>();
	private status: WebSocketStatus = "closed";
	private statusSubscribers = new Set<(status: WebSocketStatus) => void>();

	get connectionStatus(): WebSocketStatus {
		return this.status;
	}

	onStatusChange(callback: (status: WebSocketStatus) => void): () => void {
		this.statusSubscribers.add(callback);
		return () => {
			this.statusSubscribers.delete(callback);
		};
	}

	connect(): void {
		if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
			return;
		}

		this.setStatus("connecting");
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const url = `${protocol}//${window.location.host}/ws`;

		try {
			this.ws = new WebSocket(url);
		} catch {
			this.setStatus("error");
			this.scheduleReconnect();
			return;
		}

		this.ws.onopen = () => {
			this.reconnectDelay = 1000;
			this.setStatus("open");
			// Re-subscribe to any active log channels
			for (const sessionKey of this.logListeners.keys()) {
				const parts = sessionKey.match(/^(.+)\/(.+)#(.+)$/u);
				if (parts) {
					const [, owner, repo, issueNumberStr] = parts;
					const issueNumber = Number.parseInt(issueNumberStr, 10);
					if (!Number.isNaN(issueNumber)) {
						this.send({ type: "subscribe-log", owner, repo, issueNumber });
					}
				}
			}
			if (this.statusListeners.size > 0) {
				this.send({ type: "subscribe-status" });
			}
		};

		this.ws.onmessage = (event) => {
			try {
				const msg = JSON.parse(String(event.data)) as ServerMessage;
				if (msg.type === "log-entry") {
					const callbacks = this.logListeners.get(msg.sessionKey);
					if (callbacks) {
						for (const cb of callbacks) {
							cb(msg.entry);
						}
					}
				} else if (msg.type === "status") {
					for (const cb of this.statusListeners) {
						cb(msg.data);
					}
				}
			} catch {
				// ignore invalid messages
			}
		};

		this.ws.onclose = () => {
			this.setStatus("closed");
			this.scheduleReconnect();
		};

		this.ws.onerror = () => {
			this.setStatus("error");
			this.ws?.close();
		};
	}

	disconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.ws) {
			this.ws.onclose = null;
			this.ws.onerror = null;
			this.ws.close();
			this.ws = null;
		}
		this.setStatus("closed");
	}

	subscribeLog(owner: string, repo: string, issueNumber: number, callback: LogCallback): () => void {
		const sessionKey = `${owner}/${repo}#${issueNumber}`;
		let callbacks = this.logListeners.get(sessionKey);
		if (!callbacks) {
			callbacks = new Set();
			this.logListeners.set(sessionKey, callbacks);
			if (this.ws?.readyState === WebSocket.OPEN) {
				this.send({ type: "subscribe-log", owner, repo, issueNumber });
			} else {
				this.connect();
			}
		}
		callbacks.add(callback);
		return () => {
			callbacks?.delete(callback);
			if (callbacks && callbacks.size === 0) {
				this.logListeners.delete(sessionKey);
				if (this.ws?.readyState === WebSocket.OPEN) {
					this.send({ type: "unsubscribe-log", owner, repo, issueNumber });
				}
			}
		};
	}

	subscribeStatus(callback: StatusCallback): () => void {
		const wasEmpty = this.statusListeners.size === 0;
		this.statusListeners.add(callback);
		if (wasEmpty && this.ws?.readyState === WebSocket.OPEN) {
			this.send({ type: "subscribe-status" });
		} else {
			this.connect();
		}
		return () => {
			this.statusListeners.delete(callback);
			if (this.statusListeners.size === 0 && this.ws?.readyState === WebSocket.OPEN) {
				this.send({ type: "unsubscribe-status" });
			}
		};
	}

	private send(msg: { type: string; owner?: string; repo?: string; issueNumber?: number }): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	private setStatus(status: WebSocketStatus): void {
		this.status = status;
		for (const cb of this.statusSubscribers) {
			cb(status);
		}
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, this.reconnectDelay);
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
	}
}

export const webSocketManager = new WebSocketManager();
