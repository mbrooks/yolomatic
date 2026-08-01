// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, renderHook, act, within } from "@testing-library/react";
import React from "react";

import { App } from "./app/App.js";
import {
	isInProgressStatus,
	isTerminalStatus,
	IN_PROGRESS_STATUSES,
	isPausableStatus,
	PAUSABLE_STATUSES,
} from "./lib/status-helpers.js";
import { useSessionLog } from "./hooks/useSessionLog.js";

describe("isInProgressStatus", () => {
	it("returns true for working, pending, waiting-feedback, and paused", () => {
		expect(isInProgressStatus("working")).toBe(true);
		expect(isInProgressStatus("pending")).toBe(true);
		expect(isInProgressStatus("waiting-feedback")).toBe(true);
		expect(isInProgressStatus("paused")).toBe(true);
	});

	it("returns false for terminal statuses", () => {
		expect(isInProgressStatus("complete")).toBe(false);
		expect(isInProgressStatus("failed")).toBe(false);
		expect(isInProgressStatus("cancelled")).toBe(false);
	});
});

describe("isTerminalStatus", () => {
	it("returns true for complete, failed, and cancelled", () => {
		expect(isTerminalStatus("complete")).toBe(true);
		expect(isTerminalStatus("failed")).toBe(true);
		expect(isTerminalStatus("cancelled")).toBe(true);
	});

	it("returns false for in-progress statuses", () => {
		expect(isTerminalStatus("working")).toBe(false);
		expect(isTerminalStatus("pending")).toBe(false);
		expect(isTerminalStatus("waiting-feedback")).toBe(false);
		expect(isTerminalStatus("paused")).toBe(false);
	});
});

describe("IN_PROGRESS_STATUSES", () => {
	it("explicitly defines working, pending, waiting-feedback, and paused", () => {
		expect(IN_PROGRESS_STATUSES).toEqual(["working", "pending", "waiting-feedback", "paused"]);
	});
});

describe("isPausableStatus", () => {
	it("returns true for working, pending, and waiting-feedback", () => {
		expect(isPausableStatus("working")).toBe(true);
		expect(isPausableStatus("pending")).toBe(true);
		expect(isPausableStatus("waiting-feedback")).toBe(true);
	});

	it("returns false for paused and terminal statuses", () => {
		expect(isPausableStatus("paused")).toBe(false);
		expect(isPausableStatus("complete")).toBe(false);
		expect(isPausableStatus("failed")).toBe(false);
		expect(isPausableStatus("cancelled")).toBe(false);
	});
});

describe("PAUSABLE_STATUSES", () => {
	it("explicitly defines working, pending, and waiting-feedback", () => {
		expect(PAUSABLE_STATUSES).toEqual(["working", "pending", "waiting-feedback"]);
	});
});

function mockStatusResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("App", () => {
	let fetchSpy: any;

	beforeEach(() => {
		window.location.hash = "#/dashboard";
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			return mockStatusResponse({
				agent: "online",
				uptime: "1m",
				draining: false,
				repos: [
					{ owner: "mbrooks", repo: "yeetomatic", sessionCount: 3, activeCount: 2, lastActivity: new Date().toISOString() },
					{ owner: "mbrooks", repo: "case", sessionCount: 1, activeCount: 0, lastActivity: new Date().toISOString() },
				],
				sessions: [
					{
						owner: "mbrooks",
						repo: "yeetomatic",
						issueNumber: 1,
						status: "working",
						title: null,
						body: null,
						summary: null,
						workspacePath: "/ws/1",
						branch: "yeetomatic/issue-1",
						lastActivity: new Date().toISOString(),
						createdAt: new Date(Date.now() - 3600000).toISOString(),
						prUrl: null,
						prNumber: null,
						risk: { suspectedMisroute: false, reasons: [], referencedIssueNumber: null },
						staleDetectedAt: null,
						staleReason: null,
						stale: null,
					},
					{
						owner: "mbrooks",
						repo: "yeetomatic",
						issueNumber: 2,
						status: "pending",
						title: null,
						body: null,
						summary: null,
						workspacePath: "/ws/2",
						branch: "yeetomatic/issue-2",
						lastActivity: new Date().toISOString(),
						createdAt: new Date(Date.now() - 7200000).toISOString(),
						prUrl: null,
						prNumber: null,
						risk: { suspectedMisroute: false, reasons: [], referencedIssueNumber: null },
						staleDetectedAt: null,
						staleReason: null,
						stale: null,
					},
					{
						owner: "mbrooks",
						repo: "yeetomatic",
						issueNumber: 3,
						status: "complete",
						title: null,
						body: null,
						summary: null,
						workspacePath: "/ws/3",
						branch: "yeetomatic/issue-3",
						lastActivity: new Date().toISOString(),
						createdAt: new Date(Date.now() - 86400000).toISOString(),
						prUrl: null,
						prNumber: null,
						risk: { suspectedMisroute: false, reasons: [], referencedIssueNumber: null },
						staleDetectedAt: null,
						staleReason: null,
						stale: null,
					},
					{
						owner: "mbrooks",
						repo: "case",
						issueNumber: 4,
						status: "waiting-feedback",
						title: null,
						body: null,
						summary: null,
						workspacePath: "/ws/4",
						branch: "yeetomatic/issue-4",
						lastActivity: new Date().toISOString(),
						createdAt: new Date(Date.now() - 1800000).toISOString(),
						prUrl: null,
						prNumber: null,
						risk: { suspectedMisroute: false, reasons: [], referencedIssueNumber: null },
						staleDetectedAt: null,
						staleReason: null,
						stale: null,
					},
				],
			});
		});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		window.location.hash = "#/dashboard";
	});

	it("renders dashboard with stats and quick links", async () => {
		render(<App />);

		await waitFor(() => {
			expect(screen.queryByText("Active Work")).not.toBeNull();
		});

		expect(screen.queryAllByText("Online").length).toBeGreaterThan(0);
		expect(screen.queryByText("Active Work")).not.toBeNull();
		expect(screen.queryAllByText("Waiting Feedback").length).toBeGreaterThan(0);
		expect(screen.queryByText("Uptime")).not.toBeNull();
		expect(screen.queryAllByText("Repositories").length).toBeGreaterThan(0);
		expect(screen.queryAllByText("Active Sessions").length).toBeGreaterThan(0);
	});

	it("navigates to working view via quick link", async () => {
		render(<App />);

		await waitFor(() => {
			expect(screen.queryAllByText("Active Sessions").length).toBeGreaterThan(0);
		});

		fireEvent.click(screen.getByRole("button", { name: /Active Sessions/ }));

		await waitFor(() => {
			expect(screen.queryByRole("button", { name: "Dashboard" })).not.toBeNull();
		});

		// Working view should show session list with in-progress sessions
		expect(screen.queryByText("#1")).not.toBeNull();
		expect(screen.queryByText("#2")).not.toBeNull();
		expect(screen.queryByText("#4")).not.toBeNull();

		// Complete session should not appear
		expect(screen.queryByText("#3")).toBeNull();
	});

	it("shows empty state in working view when no active tasks", async () => {
		fetchSpy.mockImplementation(async () => {
			return mockStatusResponse({
				agent: "online",
				uptime: "1m",
				draining: false,
				repos: [],
				sessions: [
					{
						owner: "mbrooks",
						repo: "yeetomatic",
						issueNumber: 1,
						status: "complete",
						title: null,
						body: null,
						summary: null,
						workspacePath: "/ws/1",
						branch: "yeetomatic/issue-1",
						lastActivity: new Date().toISOString(),
						createdAt: new Date(Date.now() - 86400000).toISOString(),
						prUrl: null,
						prNumber: null,
						risk: { suspectedMisroute: false, reasons: [], referencedIssueNumber: null },
						staleDetectedAt: null,
						staleReason: null,
						stale: null,
					},
				],
			});
		});

		render(<App />);

		await waitFor(() => {
			expect(screen.queryAllByText("Active Sessions").length).toBeGreaterThan(0);
		});

		fireEvent.click(screen.getByRole("button", { name: /Active Sessions/ }));

		await waitFor(() => {
			expect(screen.queryByText("No active tasks.")).not.toBeNull();
		});
	});

	it("navigates to repo list via quick link", async () => {
		render(<App />);

		await waitFor(() => {
			expect(screen.queryAllByText("Repositories").length).toBeGreaterThan(0);
		});

		fireEvent.click(screen.getByRole("button", { name: /Repositories/ }));

		await waitFor(() => {
			expect(screen.queryByText("mbrooks/yeetomatic")).not.toBeNull();
		});
	});

	it("returns to dashboard from working view via breadcrumb", async () => {
		render(<App />);

		await waitFor(() => {
			expect(screen.queryAllByText("Active Sessions").length).toBeGreaterThan(0);
		});

		fireEvent.click(screen.getByRole("button", { name: /Active Sessions/ }));
		await waitFor(() => {
			expect(screen.queryByRole("button", { name: "Dashboard" })).not.toBeNull();
		});

		fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));

		await waitFor(() => {
			expect(screen.queryByText("Active Work")).not.toBeNull();
		});
	});

	it("allows selecting a session in working view", async () => {
		render(<App />);

		await waitFor(() => {
			expect(screen.queryAllByText("Active Sessions").length).toBeGreaterThan(0);
		});

		fireEvent.click(screen.getByRole("button", { name: /Active Sessions/ }));

		await waitFor(() => {
			expect(screen.queryByRole("button", { name: /mbrooks\/yeetomatic #1/i })).not.toBeNull();
		});

		fireEvent.click(screen.getByRole("button", { name: /mbrooks\/yeetomatic #1/i }));

		await waitFor(() => {
			expect(screen.queryByText(/Select a session from the list to view details and actions./)).toBeNull();
		});
	});

	it("shows restart banner when draining is true", async () => {
		fetchSpy.mockImplementation(async () => {
			return mockStatusResponse({
				agent: "online",
				uptime: "1m",
				draining: true,
				repos: [
					{ owner: "mbrooks", repo: "yeetomatic", sessionCount: 1, activeCount: 0, lastActivity: new Date().toISOString() },
				],
				sessions: [],
			});
		});

		render(<App />);

		await waitFor(() => {
			expect(screen.queryByText("Yeetomatic is marked for restart. Maintenance mode active.")).not.toBeNull();
		});
	});

	it("does not show restart banner when draining is false", async () => {
		render(<App />);

		await waitFor(() => {
			expect(screen.queryByText("Active Work")).not.toBeNull();
		});

		expect(screen.queryByText("Yeetomatic is marked for restart. Maintenance mode active.")).toBeNull();
	});
});

function mockLogResponse(overrides: Record<string, unknown> = {}) {
	return async (input: RequestInfo | URL) => {
		const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
		const since = url.searchParams.get("since");
		const baseLogs = (overrides.logs as { timestamp: string }[]) ?? [
			{ timestamp: "2025-01-01T00:00:00.000Z", level: "info", message: "line 1" },
			{ timestamp: "2025-01-01T00:00:01.000Z", level: "info", message: "line 2" },
		];
		const filtered = since ? baseLogs.filter((l) => l.timestamp > since) : baseLogs;
		return new Response(
			JSON.stringify({
				available: true,
				logs: filtered,
			}),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		);
	};
}

function makeSession(status: "working" | "pending" | "waiting-feedback" | "complete" | "failed" | "cancelled") {
	return {
		owner: "mbrooks",
		repo: "yeetomatic",
		issueNumber: 1,
		status,
		title: null,
		body: null,
		summary: null,
		workspacePath: "/ws/1",
		branch: "yeetomatic/issue-1",
		lastActivity: new Date().toISOString(),
		createdAt: new Date(Date.now() - 3600000).toISOString(),
		prUrl: null,
		prNumber: null,
		risk: { suspectedMisroute: false, reasons: [], referencedIssueNumber: null },
		staleDetectedAt: null,
		staleReason: null,
		stale: null,
	};
}

describe("useSessionLog", () => {
	let fetchSpy: any;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(mockLogResponse());
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		vi.useRealTimers();
	});

	it("loads log immediately when a session is selected", async () => {
		const { result } = renderHook(() => useSessionLog(makeSession("working")));

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(result.current.status).toBe("ready");
		expect(result.current.logs).toEqual([{ timestamp: "2025-01-01T00:00:00.000Z", level: "info", message: "line 1" }, { timestamp: "2025-01-01T00:00:01.000Z", level: "info", message: "line 2" }]);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("polls log endpoint for working sessions", async () => {
		vi.useFakeTimers();

		renderHook(() => useSessionLog(makeSession("working")));

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);

		await act(async () => {
			vi.advanceTimersByTime(2500);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("does not poll for complete sessions", async () => {
		vi.useFakeTimers();

		renderHook(() => useSessionLog(makeSession("complete")));

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);

		await act(async () => {
			vi.advanceTimersByTime(2500);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("stops polling when session changes from working to complete", async () => {
		vi.useFakeTimers();

		const { rerender } = renderHook(
			({ session }) => useSessionLog(session),
			{ initialProps: { session: makeSession("working") } },
		);

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);

		await act(async () => {
			vi.advanceTimersByTime(2500);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fetchSpy).toHaveBeenCalledTimes(2);

		// Transition to complete
		rerender({ session: makeSession("complete") });

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		// The effect runs once more on status change, triggering one extra load
		expect(fetchSpy).toHaveBeenCalledTimes(3);

		await act(async () => {
			vi.advanceTimersByTime(2500);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		// No more fetches after stopping polling
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});

	it("keeps log content visible after polling stops", async () => {
		vi.useFakeTimers();
		fetchSpy.mockImplementation(mockLogResponse({ logs: [{ timestamp: "2025-01-01T00:00:00.000Z", level: "info", message: "old content" }] }));

		const { rerender, result } = renderHook(
			({ session }) => useSessionLog(session),
			{ initialProps: { session: makeSession("working") } },
		);

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(result.current.logs).toEqual([{ timestamp: "2025-01-01T00:00:00.000Z", level: "info", message: "old content" }]);

		rerender({ session: makeSession("complete") });

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(result.current.logs).toEqual([{ timestamp: "2025-01-01T00:00:00.000Z", level: "info", message: "old content" }]);
	});
});
