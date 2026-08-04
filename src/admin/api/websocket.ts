import type { LogEntry, Session } from "../app/types.js";

export type WebSocketStatus = "connecting" | "open" | "closed" | "error";

export const DEFAULT_ADMIN_PATH = "/yeetomatic/admin";

function adminWsPath(): string {
	const configured =
		typeof window !== "undefined" && typeof (window as unknown as { __YEETOMATIC_ADMIN_PATH__?: unknown }).__YEETOMATIC_ADMIN_PATH__ === "string"
			? (window as unknown as { __YEETOMATIC_ADMIN_PATH__: string }).__YEETOMATIC_ADMIN_PATH__
			: DEFAULT_ADMIN_PATH;
	return configured === "/" ? "/ws" : `${configured}/ws`;
}

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

interface LogSubscription {
	owner: string;
	repo: string;
	issueNumber: number;
	kind: Session["kind"];
	callbacks: Set<LogCallback>;
}

function logSessionKey(owner: string, repo: string, issueNumber: number, kind: Session["kind"]): string {
	return `github-${owner}-${repo}-issue-${issueNumber}-${kind}`;
}

class WebSocketManager {
	private ws: WebSocket | null = null;
	private reconnectDelay = 1000;
	private readonly maxReconnectDelay = 30000;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private logListeners = new Map<string, LogSubscription>();
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
		const url = `${protocol}//${window.location.host}${adminWsPath()}`;
		let opened = false;

		try {
			this.ws = new WebSocket(url);
		} catch {
			this.setStatus("error");
			return;
		}

		this.ws.onopen = () => {
			opened = true;
			this.reconnectDelay = 1000;
			this.setStatus("open");
			// Re-subscribe to any active log channels
			for (const subscription of this.logListeners.values()) {
				this.send({
					type: "subscribe-log",
					owner: subscription.owner,
					repo: subscription.repo,
					issueNumber: subscription.issueNumber,
					kind: subscription.kind,
				});
			}
			if (this.statusListeners.size > 0) {
				this.send({ type: "subscribe-status" });
			}
		};

		this.ws.onmessage = (event) => {
			try {
				const msg = JSON.parse(String(event.data)) as ServerMessage;
				if (msg.type === "log-entry") {
					const subscription = this.logListeners.get(msg.sessionKey);
					if (subscription) {
						for (const cb of subscription.callbacks) {
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
			this.ws = null;
			this.setStatus("closed");
			if (opened && this.hasSubscribers()) {
				this.scheduleReconnect();
			}
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

	subscribeLog(owner: string, repo: string, issueNumber: number, callback: LogCallback): () => void;
	subscribeLog(owner: string, repo: string, issueNumber: number, kind: Session["kind"], callback: LogCallback): () => void;
	subscribeLog(
		owner: string,
		repo: string,
		issueNumber: number,
		kindOrCallback: Session["kind"] | LogCallback,
		maybeCallback?: LogCallback,
	): () => void {
		const kind: Session["kind"] = typeof kindOrCallback === "function" ? "implementation" : kindOrCallback;
		const callback = typeof kindOrCallback === "function" ? kindOrCallback : maybeCallback!;
		const sessionKey = logSessionKey(owner, repo, issueNumber, kind);
		let subscription = this.logListeners.get(sessionKey);
		if (!subscription) {
			subscription = { owner, repo, issueNumber, kind, callbacks: new Set() };
			this.logListeners.set(sessionKey, subscription);
			if (this.ws?.readyState === WebSocket.OPEN) {
				this.send({ type: "subscribe-log", owner, repo, issueNumber, kind });
			} else {
				this.connect();
			}
		}
		subscription.callbacks.add(callback);
		return () => {
			subscription?.callbacks.delete(callback);
			if (subscription && subscription.callbacks.size === 0) {
				this.logListeners.delete(sessionKey);
				if (this.ws?.readyState === WebSocket.OPEN) {
					this.send({ type: "unsubscribe-log", owner, repo, issueNumber, kind });
				}
				this.disconnectIfIdle();
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
			this.disconnectIfIdle();
		};
	}

	private send(msg: Record<string, unknown>): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	private sendWhenOpen(msg: Record<string, unknown>, onFailure: () => void): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.send(msg);
			return;
		}
		const waitForOpen = (status: WebSocketStatus): void => {
			if (status === "open") {
				unsubscribe();
				this.send(msg);
			} else if (status === "closed" || status === "error") {
				unsubscribe();
				onFailure();
			}
		};
		const unsubscribe = this.onStatusChange(waitForOpen);
	}

	private setStatus(status: WebSocketStatus): void {
		this.status = status;
		for (const cb of this.statusSubscribers) {
			cb(status);
		}
	}


	private scheduleReconnect(): void {
		if (this.reconnectTimer || !this.hasSubscribers()) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, this.reconnectDelay);
		if (typeof this.reconnectTimer === "object" && "unref" in this.reconnectTimer) {
			this.reconnectTimer.unref();
		}
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
	}

	private hasSubscribers(): boolean {
		return this.logListeners.size > 0 || this.statusListeners.size > 0;
	}

	private disconnectIfIdle(): void {
		if (!this.hasSubscribers()) {
			this.disconnect();
		}
	}
}

export const webSocketManager = new WebSocketManager();
