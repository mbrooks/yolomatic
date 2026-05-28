import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { SessionLogEntry } from "../logging/session-log-store.js";

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

function verifyBasicAuth(request: IncomingMessage, username: string, password: string): boolean {
	const authHeader = request.headers.authorization;
	if (!authHeader || !authHeader.startsWith("Basic ")) {
		return false;
	}
	const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
	const colonIndex = decoded.indexOf(":");
	const providedUser = colonIndex >= 0 ? decoded.slice(0, colonIndex) : decoded;
	const providedPass = colonIndex >= 0 ? decoded.slice(colonIndex + 1) : "";
	if (providedUser.length !== username.length || providedPass.length !== password.length) {
		return false;
	}
	const userMatch = timingSafeEqual(Buffer.from(providedUser), Buffer.from(username));
	const passMatch = timingSafeEqual(Buffer.from(providedPass), Buffer.from(password));
	return userMatch && passMatch;
}

export function createAdminWebSocketServer(
	httpServer: Server,
	credentialProvider: CredentialProvider,
	statusProvider?: StatusProvider,
): {
	broadcastLog: (sessionKey: string, entry: SessionLogEntry) => void;
	broadcastStatus: (data: unknown) => void;
	close: () => Promise<void>;
} {
	const clients = new Map<WebSocket, Set<string>>();
	let statusInterval: ReturnType<typeof setInterval> | null = null;

	const wss = new WebSocketServer({
		server: httpServer,
		path: "/ws",
		verifyClient: (info, callback) => {
			const req = info.req as IncomingMessage;
			const { username, password } = credentialProvider.getCredentials();
			if (!username || !password) {
				// Onboarding mode — allow connections without auth
				callback(true);
				return;
			}
			if (verifyBasicAuth(req, username, password)) {
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
		return new Promise<void>((resolve) => {
			wss.close(() => resolve());
			for (const ws of wss.clients) {
				ws.terminate();
			}
		});
	}

	return { broadcastLog, broadcastStatus, close };
}
