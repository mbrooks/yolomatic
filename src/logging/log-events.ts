import type { SessionLogEntry } from "./session-log-store.js";

export type LogEventListener = (sessionKey: string, entry: SessionLogEntry) => void;

const listeners = new Set<LogEventListener>();

export function onSessionLogEvent(listener: LogEventListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function emitSessionLogEvent(sessionKey: string, entry: SessionLogEntry): void {
	for (const listener of listeners) {
		listener(sessionKey, entry);
	}
}
