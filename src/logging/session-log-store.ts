import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runMigrations } from "../migrations/index.js";
import { emitSessionLogEvent } from "./log-events.js";

export interface SessionLogEntry {
	timestamp: string;
	level: "info" | "error" | "warn" | "tool" | "assistant";
	message: string;
	details?: Record<string, unknown>;
}

/**
 * Optional persistence backend for session logs. The in-memory map remains the
 * primary read path (it's queried synchronously by live sessions); a
 * persistence backend durably stores each entry so logs survive restarts.
 */
export interface SessionLogPersistence {
	append(sessionKey: string, entry: SessionLogEntry): void;
	clear(sessionKey: string): void;
	loadAll(): Map<string, SessionLogEntry[]>;
}

const MAX_LOGS_PER_SESSION = 5000;

const logsMap = new Map<string, SessionLogEntry[]>();
let persistence: SessionLogPersistence | null = null;

export function _resetSessionLogs(): void {
	logsMap.clear();
	persistence = null;
}

/**
 * Install a durable persistence backend. When set, every recorded entry is
 * also written to the backend, `clearSessionLogs` also clears it, and
 * `loadPersistedSessionLogs` can repopulate the in-memory map on boot.
 */
export function configureSessionLogPersistence(backend: SessionLogPersistence | null): void {
	persistence = backend;
}

/**
 * On boot, repopulate the in-memory map from the persistence backend so
 * `getSessionLogs` (synchronous) continues to serve historical entries.
 * Honors the same per-session cap as live recording.
 */
export function loadPersistedSessionLogs(): void {
	if (!persistence) return;
	const all = persistence.loadAll();
	for (const [key, entries] of all) {
		if (entries.length > MAX_LOGS_PER_SESSION) {
			logsMap.set(key, entries.slice(entries.length - MAX_LOGS_PER_SESSION));
		} else {
			logsMap.set(key, [...entries]);
		}
	}
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
	const fullEntry = { ...entry, timestamp: new Date().toISOString() };
	logs.push(fullEntry);
	if (logs.length > MAX_LOGS_PER_SESSION) {
		logs.splice(0, logs.length - MAX_LOGS_PER_SESSION);
	}
	emitSessionLogEvent(sessionKey, fullEntry);
	persistence?.append(sessionKey, fullEntry);
}

export function getSessionLogs(sessionKey: string, since?: string): SessionLogEntry[] {
	const logs = logsMap.get(sessionKey) ?? [];
	if (!since) return [...logs];
	return logs.filter((log) => log.timestamp > since);
}

export function clearSessionLogs(sessionKey: string): void {
	logsMap.delete(sessionKey);
	persistence?.clear(sessionKey);
}

/**
 * SQLite-backed {@link SessionLogPersistence}. Shares the bot-state database
 * with the other stores so session logs live alongside the rest of the
 * durable bot state.
 */
export class SessionLogStore implements SessionLogPersistence {
	private readonly db: DatabaseSync;
	private readonly insertStmt: StatementSync;
	private readonly clearStmt: StatementSync;
	private readonly loadStmt: StatementSync;

	public constructor(dbPath: string) {
		mkdirSync(path.dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL;");
		runMigrations(this.db);
		this.insertStmt = this.db.prepare(
			"INSERT INTO session_logs (session_key, timestamp, level, message, details_json) VALUES (?, ?, ?, ?, ?)",
		);
		this.clearStmt = this.db.prepare("DELETE FROM session_logs WHERE session_key = ?");
		this.loadStmt = this.db.prepare(
			"SELECT timestamp, level, message, details_json FROM session_logs WHERE session_key = ? ORDER BY id",
		);
	}

	append(sessionKey: string, entry: SessionLogEntry): void {
		this.insertStmt.run(
			sessionKey,
			entry.timestamp,
			entry.level,
			entry.message,
			entry.details ? JSON.stringify(entry.details) : null,
		);
	}

	clear(sessionKey: string): void {
		this.clearStmt.run(sessionKey);
	}

	loadAll(): Map<string, SessionLogEntry[]> {
		const stmt = this.db.prepare(
			"SELECT session_key, timestamp, level, message, details_json FROM session_logs ORDER BY id",
		);
		const rows = stmt.all() as Array<{
			session_key: string;
			timestamp: string;
			level: string;
			message: string;
			details_json: string | null;
		}>;
		const map = new Map<string, SessionLogEntry[]>();
		for (const row of rows) {
			let details: Record<string, unknown> | undefined;
			if (row.details_json) {
				try {
					details = JSON.parse(row.details_json) as Record<string, unknown>;
				} catch {
					details = undefined;
				}
			}
			const entry: SessionLogEntry = {
				timestamp: row.timestamp,
				level: row.level as SessionLogEntry["level"],
				message: row.message,
				details,
			};
			let arr = map.get(row.session_key);
			if (!arr) {
				arr = [];
				map.set(row.session_key, arr);
			}
			arr.push(entry);
		}
		return map;
	}

	/** Load a single session's logs, ordered by insertion. */
	loadForSession(sessionKey: string): SessionLogEntry[] {
		const rows = this.loadStmt.all(sessionKey) as Array<{
			timestamp: string;
			level: string;
			message: string;
			details_json: string | null;
		}>;
		return rows.map((row) => {
			let details: Record<string, unknown> | undefined;
			if (row.details_json) {
				try {
					details = JSON.parse(row.details_json) as Record<string, unknown>;
				} catch {
					details = undefined;
				}
			}
			return {
				timestamp: row.timestamp,
				level: row.level as SessionLogEntry["level"],
				message: row.message,
				details,
			};
		});
	}
}