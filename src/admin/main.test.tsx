// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

import { App, isInProgressStatus, isTerminalStatus, IN_PROGRESS_STATUSES } from "./main.js";

describe("isInProgressStatus", () => {
	it("returns true for working, pending, and waiting-feedback", () => {
		expect(isInProgressStatus("working")).toBe(true);
		expect(isInProgressStatus("pending")).toBe(true);
		expect(isInProgressStatus("waiting-feedback")).toBe(true);
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
	});
});

describe("IN_PROGRESS_STATUSES", () => {
	it("explicitly defines working, pending, and waiting-feedback", () => {
		expect(IN_PROGRESS_STATUSES).toEqual(["working", "pending", "waiting-feedback"]);
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
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			return mockStatusResponse({
				agent: "online",
				uptime: "1m",
				repos: [
					{ owner: "mbrooks", repo: "tars", sessionCount: 3, activeCount: 2 },
					{ owner: "mbrooks", repo: "case", sessionCount: 1, activeCount: 0 },
				],
				sessions: [
					{
						owner: "mbrooks",
						repo: "tars",
						issueNumber: 1,
						status: "working",
						workspacePath: "/ws/1",
						branch: "tars/issue-1",
						lastActivity: new Date().toISOString(),
						prUrl: null,
						prNumber: null,
						risk: { suspectedMisroute: false, reasons: [], referencedIssueNumber: null },
						staleDetectedAt: null,
						staleReason: null,
						stale: null,
					},
					{
						owner: "mbrooks",
						repo: "tars",
						issueNumber: 2,
						status: "pending",
						workspacePath: "/ws/2",
						branch: "tars/issue-2",
						lastActivity: new Date().toISOString(),
						prUrl: null,
						prNumber: null,
						risk: { suspectedMisroute: false, reasons: [], referencedIssueNumber: null },
						staleDetectedAt: null,
						staleReason: null,
						stale: null,
					},
					{
						owner: "mbrooks",
						repo: "tars",
						issueNumber: 3,
						status: "complete",
						workspacePath: "/ws/3",
						branch: "tars/issue-3",
						lastActivity: new Date().toISOString(),
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
						workspacePath: "/ws/4",
						branch: "tars/issue-4",
						lastActivity: new Date().toISOString(),
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
	});

	it("renders landing page with repo cards and active tasks card", async () => {
		render(<App />);

		await waitFor(() => {
			expect(screen.queryByText("mbrooks/tars")).not.toBeNull();
		});

		expect(screen.queryByText("Active Tasks")).not.toBeNull();
		expect(screen.queryByText("3 active tasks")).not.toBeNull();
		expect(screen.queryByText("mbrooks/case")).not.toBeNull();
	});

	it("does not render active task list inline on the landing page", async () => {
		render(<App />);

		await waitFor(() => {
			expect(screen.queryByText("Active Tasks")).not.toBeNull();
		});

		// The landing page should show repo cards, not a session list table
		expect(screen.queryByText("Repo")).toBeNull();
		expect(screen.queryByText("Issue")).toBeNull();
	});

	it("navigates to working view when active tasks card is clicked", async () => {
		render(<App />);

		await waitFor(() => {
			expect(screen.queryByText("Active Tasks")).not.toBeNull();
		});

		fireEvent.click(screen.getByText("Active Tasks"));

		await waitFor(() => {
			expect(screen.queryByText("Repos")).not.toBeNull();
		});

		// Breadcrumb should show "Repos → Active Tasks"
		expect(screen.queryByRole("button", { name: "Repos" })).not.toBeNull();

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
				repos: [],
				sessions: [
					{
						owner: "mbrooks",
						repo: "tars",
						issueNumber: 1,
						status: "complete",
						workspacePath: "/ws/1",
						branch: "tars/issue-1",
						lastActivity: new Date().toISOString(),
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
			expect(screen.queryByText("Active Tasks")).not.toBeNull();
		});

		fireEvent.click(screen.getByText("Active Tasks"));

		await waitFor(() => {
			expect(screen.queryByText("No active tasks.")).not.toBeNull();
		});
	});

	it("returns to repos from working view via breadcrumb", async () => {
		render(<App />);

		await waitFor(() => {
			expect(screen.queryByText("Active Tasks")).not.toBeNull();
		});

		fireEvent.click(screen.getByText("Active Tasks"));
		await waitFor(() => {
			expect(screen.queryByRole("button", { name: "Repos" })).not.toBeNull();
		});

		fireEvent.click(screen.getByRole("button", { name: "Repos" }));

		await waitFor(() => {
			expect(screen.queryByText("mbrooks/tars")).not.toBeNull();
		});
	});

	it("allows selecting a session in working view", async () => {
		render(<App />);

		await waitFor(() => {
			expect(screen.queryByText("Active Tasks")).not.toBeNull();
		});

		fireEvent.click(screen.getByText("Active Tasks"));

		await waitFor(() => {
			expect(screen.queryByText("#1")).not.toBeNull();
		});

		fireEvent.click(screen.getByText("#1"));

		await waitFor(() => {
			expect(screen.queryByText(/Select a session from the list to view details and actions./)).toBeNull();
		});
	});
});
