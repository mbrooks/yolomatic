import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { SessionLogEntry } from "../logging/session-log-store.js";
import { isAdminAuthorized } from "../adapters/http/admin-auth.js";
import type { TaskControlService } from "../ports/task-control-service.js";

export type ClientMessage =
	| { type: "subscribe-log"; owner: string; repo: string; issueNumber: number }
	| { type: "unsubscribe-log"; owner: string; repo: string; issueNumber: number }
	| { type: "subscribe-status" }
	| { type: "unsubscribe-status" };

export type ServerMessage =
	| { type: "log-entry"; sessionKey: string; entry: SessionLogEntry }
	| { type: "status"; data: unknown }
	| { type: "error"; message: string };

export interface CredentialProvider {
	getCredentials(): { username?: string; password?: string };
}

export interface StatusProvider {
	getStatus(): Promise<unknown>;
}

export function createAdminWebSocketServer(
	httpServer: Server,
	credentialProvider: CredentialProvider,
	statusProvider?: StatusProvider,
	taskControlService?: TaskControlService,
): {
	broadcastLog: (sessionKey: string, entry: SessionLogEntry) => void;
	broadcastStatus: (data: unknown) => void;
	close: () => Promise<void>;
} {
	const clients = new Map<WebSocket, Set<string>>();
	let statusInterval: ReturnType<typeof setInterval> | null = null;

	const wss = new WebSocketServer({
		server: httpServer,
		path: "/tarsadmin/ws",
		verifyClient: (info, callback) => {
			const req = info.req as IncomingMessage;
			const { username, password } = credentialProvider.getCredentials();
			if (!username || !password) {
				// Onboarding mode — allow connections without auth
				callback(true);
				return;
			}
			if (isAdminAuthorized(req, username, password)) {
				callback(true);
			} else {
				callback(false, 401, "Unauthorized");
			}
		},
	});

	function hasStatusSubscribers(): boolean {
		for (const subs of clients.values()) {
			if (subs.has("status")) return true;
		}
		return false;
	}

	function startStatusPolling(): void {
		if (statusInterval || !statusProvider) return;
		statusInterval = setInterval(() => {
			void (async () => {
				try {
					const data = await statusProvider!.getStatus();
					broadcastStatus(data);
				} catch {
					// ignore status fetch errors
				}
			})();
		}, 5000);
		statusInterval.unref?.();
	}

	function stopStatusPolling(): void {
		if (statusInterval) {
			clearInterval(statusInterval);
			statusInterval = null;
		}
	}

	wss.on("connection", (ws: WebSocket) => {
		const subscriptions = new Set<string>();
		clients.set(ws, subscriptions);

		ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
			try {
				const text = Buffer.isBuffer(raw)
					? raw.toString("utf8")
					: Array.isArray(raw)
						? Buffer.concat(raw).toString("utf8")
						: Buffer.from(raw).toString("utf8");
				const msg = JSON.parse(text) as ClientMessage;
				if (msg.type === "subscribe-log") {
					subscriptions.add(`log:${msg.owner}/${msg.repo}#${msg.issueNumber}`);
				} else if (msg.type === "unsubscribe-log") {
					subscriptions.delete(`log:${msg.owner}/${msg.repo}#${msg.issueNumber}`);
				} else if (msg.type === "subscribe-status") {
					subscriptions.add("status");
					if (hasStatusSubscribers()) {
						startStatusPolling();
					}
					// Send initial status immediately
					void (async () => {
						try {
							if (!statusProvider) return;
							const data = await statusProvider.getStatus();
							if (ws.readyState === WebSocket.OPEN) {
								ws.send(JSON.stringify({ type: "status", data } satisfies ServerMessage));
							}
						} catch {
							/* ignore */
						}
					})();
				} else if (msg.type === "unsubscribe-status") {
					subscriptions.delete("status");
					if (!hasStatusSubscribers()) {
						stopStatusPolling();
					}
				}
			} catch {
				// ignore invalid messages
			}
		});

		ws.on("close", () => {
			clients.delete(ws);
			if (!hasStatusSubscribers()) {
				stopStatusPolling();
			}
		});

		ws.on("error", () => {
			clients.delete(ws);
			if (!hasStatusSubscribers()) {
				stopStatusPolling();
			}
		});
	});

	function broadcastLog(sessionKey: string, entry: SessionLogEntry): void {
		const channel = `log:${sessionKey}`;
		const payload = JSON.stringify({ type: "log-entry", sessionKey, entry } satisfies ServerMessage);
		for (const [ws, subs] of clients) {
			if (subs.has(channel) && ws.readyState === WebSocket.OPEN) {
				ws.send(payload);
			}
		}
	}

	function broadcastStatus(data: unknown): void {
		const payload = JSON.stringify({ type: "status", data } satisfies ServerMessage);
		for (const [ws, subs] of clients) {
			if (subs.has("status") && ws.readyState === WebSocket.OPEN) {
				ws.send(payload);
			}
		}
	}

	function close(): Promise<void> {
		stopStatusPolling();
		for (const ws of wss.clients) {
			ws.terminate();
		}
		return new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) {
					return;
				}
				settled = true;
				resolve();
			};
			wss.close(() => finish());
			setTimeout(finish, 0);
		});
	}

	return { broadcastLog, broadcastStatus, close };
}
