import { randomUUID } from "node:crypto";
import type { Server } from "node:http";

import WebSocket, { WebSocketServer } from "ws";

import type { AnyWorkerProtocolMessage, WorkerProtocolMessage } from "./protocol.js";
import { decodeWorkerWebSocketMessage, sendWorkerWebSocketMessage } from "./websocket-transport.js";

export const WORKER_RPC_PATH = "/yeetomatic-worker/ws";

export interface WorkerRpcConnection {
	send(message: WorkerProtocolMessage): Promise<void>;
	onMessage(listener: (message: AnyWorkerProtocolMessage) => void): () => void;
	onClose(listener: () => void): () => void;
	onError(listener: (error: Error) => void): () => void;
	isOpen(): boolean;
	close(code?: number, reason?: string): void;
}

export interface PendingWorkerRpcConnection {
	token: string;
	waitForConnection(): Promise<WorkerRpcConnection>;
	dispose(error?: Error): void;
}

interface PendingSession {
	token: string;
	sessionKey: string;
	resolve: (connection: WorkerRpcConnection) => void;
	reject: (error: Error) => void;
	connected: boolean;
}

class WorkerRpcConnectionImpl implements WorkerRpcConnection {
	private readonly messageListeners = new Set<(message: AnyWorkerProtocolMessage) => void>();
	private readonly closeListeners = new Set<() => void>();
	private readonly errorListeners = new Set<(error: Error) => void>();
	private readonly bufferedMessages: AnyWorkerProtocolMessage[] = [];
	private readonly bufferedErrors: Error[] = [];
	private closed = false;

	constructor(
		private readonly ws: WebSocket,
		private readonly onTerminate: () => void,
	) {
		this.ws.on("message", (raw) => {
			try {
				const message = decodeWorkerWebSocketMessage(raw);
				if (this.messageListeners.size === 0) {
					this.bufferedMessages.push(message);
					return;
				}
				for (const listener of this.messageListeners) {
					listener(message);
				}
			} catch (error) {
				this.emitError(error instanceof Error ? error : new Error(String(error)));
			}
		});

		this.ws.on("close", () => {
			this.closed = true;
			this.onTerminate();
			for (const listener of this.closeListeners) {
				listener();
			}
		});

		this.ws.on("error", (error) => {
			this.emitError(error instanceof Error ? error : new Error(String(error)));
		});
	}

	send(message: WorkerProtocolMessage): Promise<void> {
		return sendWorkerWebSocketMessage(this.ws, message);
	}

	onMessage(listener: (message: AnyWorkerProtocolMessage) => void): () => void {
		this.messageListeners.add(listener);
		for (const message of this.bufferedMessages.splice(0)) {
			listener(message);
		}
		return () => {
			this.messageListeners.delete(listener);
		};
	}

	onClose(listener: () => void): () => void {
		if (this.closed) {
			listener();
			return () => undefined;
		}
		this.closeListeners.add(listener);
		return () => {
			this.closeListeners.delete(listener);
		};
	}

	onError(listener: (error: Error) => void): () => void {
		this.errorListeners.add(listener);
		for (const error of this.bufferedErrors.splice(0)) {
			listener(error);
		}
		return () => {
			this.errorListeners.delete(listener);
		};
	}

	isOpen(): boolean {
		return this.ws.readyState === WebSocket.OPEN;
	}

	close(code = 1000, reason?: string): void {
		if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
			this.ws.close(code, reason);
		}
	}

	private emitError(error: Error): void {
		if (this.errorListeners.size === 0) {
			this.bufferedErrors.push(error);
			return;
		}
		for (const listener of this.errorListeners) {
			listener(error);
		}
	}
}

export class WorkerRpcServer {
	private readonly pendingSessions = new Map<string, PendingSession>();
	private readonly activeConnections = new Set<WorkerRpcConnectionImpl>();
	private websocketServer?: WebSocketServer;
	private attached = false;

	attach(server: Server): void {
		if (this.attached) return;
		this.attached = true;
		this.websocketServer = new WebSocketServer({ noServer: true });

		server.on("upgrade", (request, socket, head) => {
			const url = request.url ? new URL(request.url, "http://localhost") : null;
			if (!url || url.pathname !== WORKER_RPC_PATH) {
				return;
			}

			const token = url.searchParams.get("token")?.trim();
			const sessionKey = url.searchParams.get("sessionKey")?.trim();
			const pending = token ? this.pendingSessions.get(token) : undefined;

			if (!token || !sessionKey || !pending || pending.sessionKey !== sessionKey) {
				socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
				socket.destroy();
				return;
			}

			this.pendingSessions.delete(token);
			this.websocketServer!.handleUpgrade(request, socket, head, (ws) => {
				const connection = new WorkerRpcConnectionImpl(ws, () => {
					this.activeConnections.delete(connection);
				});
				this.activeConnections.add(connection);
				pending.connected = true;
				pending.resolve(connection);
			});
		});
	}

	createPendingConnection(sessionKey: string): PendingWorkerRpcConnection {
		const token = randomUUID();
		let resolveConnection!: (connection: WorkerRpcConnection) => void;
		let rejectConnection!: (error: Error) => void;
		const connectionPromise = new Promise<WorkerRpcConnection>((resolve, reject) => {
			resolveConnection = resolve;
			rejectConnection = reject;
		});

		const pending: PendingSession = {
			token,
			sessionKey,
			resolve: resolveConnection,
			reject: rejectConnection,
			connected: false,
		};
		this.pendingSessions.set(token, pending);

		return {
			token,
			waitForConnection: () => connectionPromise,
			dispose: (error = new Error(`Worker RPC connection was not established for ${sessionKey}`)) => {
				if (this.pendingSessions.get(token) !== pending) {
					return;
				}
				this.pendingSessions.delete(token);
				if (!pending.connected) {
					pending.reject(error);
				}
			},
		};
	}

	async close(): Promise<void> {
		for (const pending of this.pendingSessions.values()) {
			pending.reject(new Error(`Worker RPC server closed before ${pending.sessionKey} connected`));
		}
		this.pendingSessions.clear();

		for (const connection of this.activeConnections) {
			connection.close(1012, "server closing");
		}
		this.activeConnections.clear();

		if (!this.websocketServer) {
			return;
		}

		await new Promise<void>((resolve) => {
			this.websocketServer!.close(() => resolve());
		});
	}
}
