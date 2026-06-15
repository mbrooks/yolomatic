import { describe, expect, it, vi } from "vitest";
import { formatRelative, formatDuration, formatMs, labelAgentStatus } from "./format.js";

describe("formatRelative", () => {
	it("returns seconds ago for recent timestamps", () => {
		const now = Date.now();
		const iso = new Date(now - 5_000).toISOString();
		expect(formatRelative(iso)).toBe("5s ago");
	});

	it("returns minutes ago", () => {
		const iso = new Date(Date.now() - 90_000).toISOString();
		expect(formatRelative(iso)).toBe("1m ago");
	});

	it("returns hours ago", () => {
		const iso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
		expect(formatRelative(iso)).toBe("3h ago");
	});

	it("returns days ago", () => {
		const iso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		expect(formatRelative(iso)).toBe("2d ago");
	});
});

describe("formatDuration", () => {
	it("returns seconds", () => {
		const iso = new Date(Date.now() - 5_000).toISOString();
		expect(formatDuration(iso)).toBe("5s");
	});

	it("returns minutes", () => {
		const iso = new Date(Date.now() - 90_000).toISOString();
		expect(formatDuration(iso)).toBe("1m");
	});

	it("returns hours and minutes", () => {
		const iso = new Date(Date.now() - 3 * 60 * 60 * 1000 - 30 * 60 * 1000).toISOString();
		expect(formatDuration(iso)).toBe("3h 30m");
	});

	it("returns days and hours", () => {
		const iso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 - 5 * 60 * 60 * 1000).toISOString();
		expect(formatDuration(iso)).toBe("2d 5h");
	});
});

describe("formatMs", () => {
	it("returns em-dash for null", () => {
		expect(formatMs(null)).toBe("–");
	});

	it("returns seconds", () => {
		expect(formatMs(5_000)).toBe("5s");
	});

	it("returns minutes", () => {
		expect(formatMs(90_000)).toBe("1m");
	});

	it("returns hours and minutes", () => {
		expect(formatMs(3 * 60 * 60 * 1000 + 30 * 60 * 1000)).toBe("3h 30m");
	});

	it("returns days and hours", () => {
		expect(formatMs(2 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000)).toBe("2d 5h");
	});
});

describe("labelAgentStatus", () => {
	it("labels known statuses", () => {
		expect(labelAgentStatus("online")).toBe("Online");
		expect(labelAgentStatus("busy")).toBe("Busy");
		expect(labelAgentStatus("feedback")).toBe("Feedback");
		expect(labelAgentStatus("offline")).toBe("Offline");
	});
});
