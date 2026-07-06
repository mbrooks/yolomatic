import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	recordSessionLog,
	getSessionLogs,
	clearSessionLogs,
	_resetSessionLogs,
	configureSessionLogPersistence,
	loadPersistedSessionLogs,
	SessionLogStore,
} from "./session-log-store.js";
import { onSessionLogEvent } from "./log-events.js";

const TEST_DB = path.join(os.tmpdir(), "tars-session-log-test.sqlite");

describe("session-log-store", () => {
	beforeEach(() => {
		_resetSessionLogs();
	});

	it("stores and retrieves logs", () => {
		recordSessionLog("session-1", { level: "info", message: "hello" });
		recordSessionLog("session-1", { level: "error", message: "boom" });

		const logs = getSessionLogs("session-1");
		expect(logs).toHaveLength(2);
		expect(logs[0].level).toBe("info");
		expect(logs[1].level).toBe("error");
	});

	it("filters logs by since timestamp", async () => {
		recordSessionLog("session-1", { level: "info", message: "first" });
		await new Promise((r) => setTimeout(r, 10));
		const logs = getSessionLogs("session-1");
		const since = logs[0].timestamp;

		recordSessionLog("session-1", { level: "info", message: "second" });
		const filtered = getSessionLogs("session-1", since);

		expect(filtered).toHaveLength(1);
		expect(filtered[0].message).toBe("second");
	});

	it("clears logs for a session", () => {
		recordSessionLog("session-1", { level: "info", message: "hello" });
		clearSessionLogs("session-1");

		expect(getSessionLogs("session-1")).toHaveLength(0);
	});

	it("emits log event when recording", () => {
		const listener = vi.fn();
		const unsub = onSessionLogEvent(listener);

		recordSessionLog("session-1", { level: "warn", message: " emitted" });

		expect(listener).toHaveBeenCalledOnce();
		const [, entry] = listener.mock.calls[0] as [string, { timestamp: string; level: string; message: string }];
		expect(entry.level).toBe("warn");
		expect(entry.message).toBe(" emitted");
		expect(entry.timestamp).toBeTypeOf("string");
		unsub();
	});

	it("truncates logs when exceeding max limit", () => {
		for (let i = 0; i < 5002; i++) {
			recordSessionLog("session-1", { level: "info", message: `log-${i}` });
		}
		const logs = getSessionLogs("session-1");
		expect(logs.length).toBe(5000);
		expect(logs[0].message).toBe("log-2");
	});
});

describe("session-log-store persistence", () => {
	beforeEach(() => {
		try {
			unlinkSync(TEST_DB);
		} catch {
			// ignore
		}
		try {
			unlinkSync(`${TEST_DB}-wal`);
		} catch {
			// ignore
		}
		try {
			unlinkSync(`${TEST_DB}-shm`);
		} catch {
			// ignore
		}
		_resetSessionLogs();
	});

	afterEach(() => {
		configureSessionLogPersistence(null);
		try {
			unlinkSync(TEST_DB);
		} catch {
			// ignore
		}
		try {
			unlinkSync(`${TEST_DB}-wal`);
		} catch {
			// ignore
		}
		try {
			unlinkSync(`${TEST_DB}-shm`);
		} catch {
			// ignore
		}
	});

	it("persists recorded logs to SQLite and reloads them on boot", () => {
		configureSessionLogPersistence(new SessionLogStore(TEST_DB));
		recordSessionLog("session-1", { level: "info", message: "hello", details: { type: "prompt" } });
		recordSessionLog("session-1", { level: "error", message: "boom" });
		recordSessionLog("session-2", { level: "tool", message: "ran tool" });

		// Simulate a restart: reset memory, reconfigure, reload.
		_resetSessionLogs();
		expect(getSessionLogs("session-1")).toHaveLength(0);

		configureSessionLogPersistence(new SessionLogStore(TEST_DB));
		loadPersistedSessionLogs();

		expect(getSessionLogs("session-1")).toHaveLength(2);
		expect(getSessionLogs("session-1")[0].message).toBe("hello");
		expect(getSessionLogs("session-1")[0].details).toEqual({ type: "prompt" });
		expect(getSessionLogs("session-2")).toHaveLength(1);
		expect(getSessionLogs("session-2")[0].level).toBe("tool");
	});

	it("clearSessionLogs also clears SQLite persistence", () => {
		const store = new SessionLogStore(TEST_DB);
		configureSessionLogPersistence(store);
		recordSessionLog("session-1", { level: "info", message: "hello" });
		clearSessionLogs("session-1");

		_resetSessionLogs();
		configureSessionLogPersistence(new SessionLogStore(TEST_DB));
		loadPersistedSessionLogs();
		expect(getSessionLogs("session-1")).toHaveLength(0);
	});

	it("loadPersistedSessionLogs is a no-op without a backend", () => {
		configureSessionLogPersistence(null);
		expect(() => loadPersistedSessionLogs()).not.toThrow();
	});

	it("loadForSession returns entries in insertion order", () => {
		const store = new SessionLogStore(TEST_DB);
		store.append("s1", { timestamp: "t1", level: "info", message: "a" });
		store.append("s1", { timestamp: "t2", level: "error", message: "b", details: { x: 1 } });
		const loaded = store.loadForSession("s1");
		expect(loaded).toHaveLength(2);
		expect(loaded[0].message).toBe("a");
		expect(loaded[1].details).toEqual({ x: 1 });
		expect(store.loadForSession("missing")).toEqual([]);
	});

	it("loadAll groups entries by session key", () => {
		const store = new SessionLogStore(TEST_DB);
		store.append("s1", { timestamp: "t1", level: "info", message: "a" });
		store.append("s2", { timestamp: "t2", level: "info", message: "b" });
		store.append("s1", { timestamp: "t3", level: "info", message: "c" });
		const all = store.loadAll();
		expect(all.get("s1")?.map((e) => e.message)).toEqual(["a", "c"]);
		expect(all.get("s2")?.map((e) => e.message)).toEqual(["b"]);
	});

	it("ignores malformed details_json when loading", () => {
		const store = new SessionLogStore(TEST_DB);
		store.append("s1", { timestamp: "t1", level: "info", message: "a", details: { ok: true } });
		// Corrupt details_json directly via a second connection.
		const { DatabaseSync } = require("node:sqlite");
		const raw = new DatabaseSync(TEST_DB);
		raw.exec("UPDATE session_logs SET details_json = '{not json' WHERE message = 'a'");
		raw.close();

		const loaded = store.loadForSession("s1");
		expect(loaded[0].details).toBeUndefined();
	});

	it("does not persist when no backend is configured", () => {
		configureSessionLogPersistence(null);
		recordSessionLog("session-1", { level: "info", message: "hello" });
		const store = new SessionLogStore(TEST_DB);
		expect(store.loadForSession("session-1")).toEqual([]);
	});
});
