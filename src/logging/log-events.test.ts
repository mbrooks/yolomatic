import { describe, expect, it, vi } from "vitest";
import { onSessionLogEvent, emitSessionLogEvent } from "./log-events.js";
import type { SessionLogEntry } from "./session-log-store.js";

describe("log-events", () => {
	it("calls listener when event is emitted", () => {
		const listener = vi.fn();
		const entry: SessionLogEntry = {
			timestamp: "2025-01-01T00:00:00.000Z",
			level: "info",
			message: "test",
		};

		const unsubscribe = onSessionLogEvent(listener);
		emitSessionLogEvent("mbrooks/yeetomatic#1", entry);

		expect(listener).toHaveBeenCalledWith("mbrooks/yeetomatic#1", entry);
		unsubscribe();
	});

	it("does not call listener after unsubscribe", () => {
		const listener = vi.fn();
		const entry: SessionLogEntry = {
			timestamp: "2025-01-01T00:00:00.000Z",
			level: "info",
			message: "test",
		};

		const unsubscribe = onSessionLogEvent(listener);
		unsubscribe();
		emitSessionLogEvent("mbrooks/yeetomatic#1", entry);

		expect(listener).not.toHaveBeenCalled();
	});

	it("calls multiple listeners", () => {
		const listener1 = vi.fn();
		const listener2 = vi.fn();
		const entry: SessionLogEntry = {
			timestamp: "2025-01-01T00:00:00.000Z",
			level: "error",
			message: "boom",
		};

		const unsub1 = onSessionLogEvent(listener1);
		const unsub2 = onSessionLogEvent(listener2);
		emitSessionLogEvent("owner/repo#42", entry);

		expect(listener1).toHaveBeenCalledWith("owner/repo#42", entry);
		expect(listener2).toHaveBeenCalledWith("owner/repo#42", entry);
		unsub1();
		unsub2();
	});
});
