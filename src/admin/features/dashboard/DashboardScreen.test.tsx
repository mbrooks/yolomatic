// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import React from "react";

import { DashboardScreen } from "./DashboardScreen.js";
import type { AgentStatus, RepoSummary, Session } from "../../app/types.js";

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		owner: "mbrooks",
		repo: "tars",
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
		...overrides,
	};
}

const defaultProps = {
	agentStatus: "online" as AgentStatus,
	uptime: "1m",
	draining: false,
	repos: [] as RepoSummary[],
	sessions: [] as Session[],
	onSelectWorking: vi.fn(),
	onSelectRepos: vi.fn(),
	onSelectSession: vi.fn(),
};

describe("DashboardScreen", () => {
	it("renders empty state when no recent sessions", async () => {
		render(<DashboardScreen {...defaultProps} />);

		await waitFor(() => {
			expect(screen.getByText("No recent sessions.")).not.toBeNull();
		});
	});

	it("renders recent activity table headers", () => {
		const sessions = [makeSession()];
		render(<DashboardScreen {...defaultProps} sessions={sessions} />);

		const activityList = document.querySelector(".activity-list");
		expect(activityList).not.toBeNull();

		const headers = activityList!.querySelectorAll(".activity-list-header > div");
		expect(headers[0].textContent).toBe("Repo");
		expect(headers[1].textContent).toBe("Issue");
		expect(headers[2].textContent).toBe("Status");
		expect(headers[3].textContent).toBe("Activity");
	});

	it("renders recent session rows", () => {
		const sessions = [
			makeSession({ owner: "mbrooks", repo: "tars", issueNumber: 1, status: "working" }),
			makeSession({ owner: "mbrooks", repo: "case", issueNumber: 2, status: "complete" }),
		];
		render(<DashboardScreen {...defaultProps} sessions={sessions} />);

		const recentActivity = document.querySelector(".dashboard-section:has(h2):has(.activity-list)");
		expect(recentActivity).not.toBeNull();
		expect(within(recentActivity as HTMLElement).getByText("mbrooks/tars")).not.toBeNull();
		expect(within(recentActivity as HTMLElement).getByText("#1")).not.toBeNull();
		expect(within(recentActivity as HTMLElement).getByText("mbrooks/case")).not.toBeNull();
		expect(within(recentActivity as HTMLElement).getByText("#2")).not.toBeNull();
	});

	it("calls onSelectSession when a row is clicked", () => {
		const onSelectSession = vi.fn();
		const sessions = [makeSession()];
		render(<DashboardScreen {...defaultProps} sessions={sessions} onSelectSession={onSelectSession} />);

		const row = document.querySelector(".activity-row");
		expect(row).not.toBeNull();
		fireEvent.click(row!);

		expect(onSelectSession).toHaveBeenCalledTimes(1);
		expect(onSelectSession).toHaveBeenCalledWith(sessions[0]);
	});

	it("calls onSelectSession when Enter is pressed on a row", () => {
		const onSelectSession = vi.fn();
		const sessions = [makeSession()];
		render(<DashboardScreen {...defaultProps} sessions={sessions} onSelectSession={onSelectSession} />);

		const row = document.querySelector(".activity-row");
		expect(row).not.toBeNull();
		fireEvent.keyDown(row!, { key: "Enter" });

		expect(onSelectSession).toHaveBeenCalledTimes(1);
		expect(onSelectSession).toHaveBeenCalledWith(sessions[0]);
	});

	it("calls onSelectSession when Space is pressed on a row", () => {
		const onSelectSession = vi.fn();
		const sessions = [makeSession()];
		render(<DashboardScreen {...defaultProps} sessions={sessions} onSelectSession={onSelectSession} />);

		const row = document.querySelector(".activity-row");
		expect(row).not.toBeNull();
		fireEvent.keyDown(row!, { key: " " });

		expect(onSelectSession).toHaveBeenCalledTimes(1);
		expect(onSelectSession).toHaveBeenCalledWith(sessions[0]);
	});

	it("does not call onSelectSession for other keys", () => {
		const onSelectSession = vi.fn();
		const sessions = [makeSession()];
		render(<DashboardScreen {...defaultProps} sessions={sessions} onSelectSession={onSelectSession} />);

		const row = document.querySelector(".activity-row");
		expect(row).not.toBeNull();
		fireEvent.keyDown(row!, { key: "Escape" });

		expect(onSelectSession).not.toHaveBeenCalled();
	});

	it("limits recent sessions to 10", () => {
		const sessions = Array.from({ length: 15 }, (_, i) =>
			makeSession({
				issueNumber: i + 1,
				lastActivity: new Date(Date.now() - i * 1000).toISOString(),
			}),
		);
		render(<DashboardScreen {...defaultProps} sessions={sessions} />);

		const recentActivityList = document.querySelector(".activity-list");
		expect(recentActivityList).not.toBeNull();
		const rows = recentActivityList!.querySelectorAll(".activity-row");
		expect(rows.length).toBe(10);
	});

	it("sorts recent sessions by lastActivity descending", () => {
		const sessions = [
			makeSession({ issueNumber: 1, lastActivity: new Date(Date.now() - 5000).toISOString() }),
			makeSession({ issueNumber: 2, lastActivity: new Date(Date.now() - 1000).toISOString() }),
			makeSession({ issueNumber: 3, lastActivity: new Date(Date.now() - 3000).toISOString() }),
		];
		render(<DashboardScreen {...defaultProps} sessions={sessions} />);

		const recentActivityList = document.querySelector(".activity-list");
		expect(recentActivityList).not.toBeNull();
		const rows = recentActivityList!.querySelectorAll(".activity-row");
		expect(rows[0].querySelector(".activity-issue")?.textContent).toBe("#2");
		expect(rows[1].querySelector(".activity-issue")?.textContent).toBe("#3");
		expect(rows[2].querySelector(".activity-issue")?.textContent).toBe("#1");
	});

	it("calls quick link handlers", () => {
		const onSelectWorking = vi.fn();
		const onSelectRepos = vi.fn();

		render(
			<DashboardScreen
				{...defaultProps}
				onSelectWorking={onSelectWorking}
				onSelectRepos={onSelectRepos}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /Active Sessions/ }));
		expect(onSelectWorking).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: /Repositories/ }));
		expect(onSelectRepos).toHaveBeenCalledTimes(1);
	});

	it("shows draining state when draining is true", () => {
		render(<DashboardScreen {...defaultProps} draining={true} />);
		expect(screen.getByText("Draining")).not.toBeNull();
	});

	it("does not show draining state when draining is false", () => {
		render(<DashboardScreen {...defaultProps} draining={false} />);
		expect(screen.queryByText("Draining")).toBeNull();
	});
});
