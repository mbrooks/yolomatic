import { describe, expect, it, vi, beforeEach } from "vitest";
import { recordSessionLog, getSessionLogs, clearSessionLogs, _resetSessionLogs } from "./session-log-store.js";
import { onSessionLogEvent } from "./log-events.js";

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
