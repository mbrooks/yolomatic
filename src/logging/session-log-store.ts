export interface SessionLogEntry {
	timestamp: string;
	level: "info" | "error" | "warn" | "tool" | "assistant";
	message: string;
	details?: Record<string, unknown>;
}

const MAX_LOGS_PER_SESSION = 5000;

const logsMap = new Map<string, SessionLogEntry[]>();

export function _resetSessionLogs(): void {
	logsMap.clear();
}

export function recordSessionLog(
	sessionKey: string,
	entry: Omit<SessionLogEntry, "timestamp">,
): void {
	let logs = logsMap.get(sessionKey);
	if (!logs) {
		logs = [];
		logsMap.set(sessionKey, logs);
	}
	logs.push({ ...entry, timestamp: new Date().toISOString() });
	if (logs.length > MAX_LOGS_PER_SESSION) {
		logs.splice(0, logs.length - MAX_LOGS_PER_SESSION);
	}
}

export function getSessionLogs(sessionKey: string, since?: string): SessionLogEntry[] {
	const logs = logsMap.get(sessionKey) ?? [];
	if (!since) return [...logs];
	return logs.filter((log) => log.timestamp > since);
}

export function clearSessionLogs(sessionKey: string): void {
	logsMap.delete(sessionKey);
}
