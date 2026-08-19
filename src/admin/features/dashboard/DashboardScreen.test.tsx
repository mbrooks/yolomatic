// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import React from "react";

import { DashboardScreen } from "./DashboardScreen.js";
import type { AgentStatus, MetricsResponse, RepoSummary, Session, SessionMetric } from "../../app/types.js";

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		kind: "implementation",
		owner: "mbrooks",
		repo: "yolomatic",
		issueNumber: 1,
		status: "working",
		title: null,
		body: null,
		summary: null,
		workspacePath: "/ws/1",
		branch: "yolomatic/issue-1",
		lastActivity: new Date().toISOString(),
		createdAt: new Date(Date.now() - 3600000).toISOString(),
		prUrl: null,
		prNumber: null,
		risk: { suspectedMisroute: false, reasons: [], referencedIssueNumber: null },
		staleDetectedAt: null,
		staleReason: null,
		stale: null,
		taskStartedAt: null,
		taskFinishedAt: null,
		totalExecutionTimeMs: null,
		...overrides,
	};
}

function makeMetric(overrides: Partial<SessionMetric> = {}): SessionMetric {
	return {
		sessionKey: "github-mbrooks-yolomatic-issue-1-implementation",
		owner: "mbrooks",
		repo: "yolomatic",
		issueNumber: 1,
		kind: "implementation",
		status: "complete",
		startedAt: "2026-08-01T00:00:00.000Z",
		finishedAt: "2026-08-01T00:01:00.000Z",
		durationMs: 60000,
		tokenUsage: { available: true, input: 10, output: 5, totalTokens: 15, cost: 0.3 },
		...overrides,
	};
}

function metricsWith(recent: SessionMetric[], buckets: MetricsResponse["buckets"] = []): MetricsResponse {
	return { windowDays: 7, buckets, recent };
}

const defaultProps = {
	agentStatus: "online" as AgentStatus,
	uptime: "1m",
	draining: false,
	repos: [] as RepoSummary[],
	sessions: [] as Session[],
	metrics: null as MetricsResponse | null,
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
		expect(headers[2].textContent).toBe("Type");
		expect(headers[3].textContent).toBe("Status");
		expect(headers[4].textContent).toBe("Activity");
	});

	it("renders recent session rows", () => {
		const sessions = [
			makeSession({ owner: "mbrooks", repo: "yolomatic", issueNumber: 1, status: "working" }),
			makeSession({ owner: "mbrooks", repo: "case", issueNumber: 2, status: "complete" }),
		];
		render(<DashboardScreen {...defaultProps} sessions={sessions} />);

		const recentActivity = document.querySelector(".dashboard-section:has(h2):has(.activity-list)");
		expect(recentActivity).not.toBeNull();
		expect(within(recentActivity as HTMLElement).getByText("mbrooks/yolomatic")).not.toBeNull();
		expect(within(recentActivity as HTMLElement).getByText("#1")).not.toBeNull();
		expect(within(recentActivity as HTMLElement).getByText("mbrooks/case")).not.toBeNull();
		expect(within(recentActivity as HTMLElement).getByText("#2")).not.toBeNull();
	});

	it("renders implementation and refinement rows for the same issue", () => {
		const sessions = [
			makeSession({ kind: "implementation", issueNumber: 534 }),
			makeSession({ kind: "refinement", issueNumber: 534 }),
		];
		render(<DashboardScreen {...defaultProps} sessions={sessions} />);

		expect(document.querySelectorAll(".activity-row")).toHaveLength(2);
		expect(document.querySelectorAll(".activity-issue")[1].textContent).toBe("#534");
		expect(document.querySelector(".type-badge.implementation")?.textContent).toBe("Issue");
		expect(document.querySelector(".type-badge.refinement")?.textContent).toBe("Refinement");
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

	it("renders a session only once when it appears in both sessions and metrics.recent", () => {
		const sessions = [
			makeSession({
				owner: "mbrooks",
				repo: "yolomatic",
				issueNumber: 1,
				kind: "implementation",
				lastActivity: "2026-08-01T12:00:00.000Z",
			}),
		];
		const metrics = metricsWith([
			makeMetric({
				sessionKey: "github-mbrooks-yolomatic-issue-1-implementation",
				issueNumber: 1,
				finishedAt: "2026-08-01T00:01:00.000Z",
			}),
		]);

		render(<DashboardScreen {...defaultProps} sessions={sessions} metrics={metrics} />);

		const rows = document.querySelectorAll(".activity-row");
		expect(rows).toHaveLength(1);
		expect(rows[0].textContent).toContain("#1");
	});

	it("renders a metrics-only row when the session is no longer live", () => {
		const metrics = metricsWith([
			makeMetric({
				sessionKey: "github-mbrooks-yolomatic-issue-2-implementation",
				issueNumber: 2,
				finishedAt: "2026-08-02T00:01:00.000Z",
			}),
		]);

		render(<DashboardScreen {...defaultProps} sessions={[]} metrics={metrics} />);

		const rows = document.querySelectorAll(".activity-row");
		expect(rows).toHaveLength(1);
		expect(rows[0].textContent).toContain("#2");
		expect(rows[0].textContent).toContain("mbrooks/yolomatic");
		// Metrics-only rows are non-interactive.
		expect(rows[0].getAttribute("role"))?.toBeFalsy();
	});

	it("orders merged live and metrics-only rows most-recent-first", () => {
		const sessions = [
			makeSession({ issueNumber: 1, lastActivity: "2026-08-01T05:00:00.000Z" }),
			makeSession({ issueNumber: 3, lastActivity: "2026-08-03T05:00:00.000Z" }),
		];
		const metrics = metricsWith([
			makeMetric({
				sessionKey: "github-mbrooks-yolomatic-issue-2-implementation",
				issueNumber: 2,
				finishedAt: "2026-08-02T05:00:00.000Z",
			}),
		]);

		render(<DashboardScreen {...defaultProps} sessions={sessions} metrics={metrics} />);

		const issueCells = Array.from(document.querySelectorAll(".activity-row .activity-issue")).map((c) => c.textContent);
		expect(issueCells).toEqual(["#3", "#2", "#1"]);
	});

	it("caps the merged recent activity list at 10 rows", () => {
		const sessions = Array.from({ length: 6 }, (_, i) =>
			makeSession({
				issueNumber: i + 1,
				lastActivity: `2026-08-0${i + 1}T05:00:00.000Z`,
			}),
		);
		const recent = Array.from({ length: 8 }, (_, i) =>
			makeMetric({
				sessionKey: `github-mbrooks-yolomatic-issue-${i + 7}-implementation`,
				issueNumber: i + 7,
				finishedAt: `2026-08-0${i + 7}T05:00:00.000Z`,
			}),
		);

		render(<DashboardScreen {...defaultProps} sessions={sessions} metrics={metricsWith(recent)} />);

		expect(document.querySelectorAll(".activity-row")).toHaveLength(10);
	});

	it("does not call onSelectSession when a metrics-only row is clicked", () => {
		const onSelectSession = vi.fn();
		const metrics = metricsWith([
			makeMetric({
				sessionKey: "github-mbrooks-yolomatic-issue-2-implementation",
				issueNumber: 2,
				finishedAt: "2026-08-02T00:01:00.000Z",
			}),
		]);

		render(<DashboardScreen {...defaultProps} sessions={[]} metrics={metrics} onSelectSession={onSelectSession} />);

		const row = document.querySelector(".activity-row");
		expect(row).not.toBeNull();
		fireEvent.click(row!);

		expect(onSelectSession).not.toHaveBeenCalled();
	});

	it("still opens a live session row via click when metrics are also present", () => {
		const onSelectSession = vi.fn();
		const session = makeSession({
			issueNumber: 1,
			lastActivity: "2026-08-01T12:00:00.000Z",
		});
		const metrics = metricsWith([
			makeMetric({
				sessionKey: "github-mbrooks-yolomatic-issue-1-implementation", issueNumber: 1 }),
			makeMetric({
				sessionKey: "github-mbrooks-yolomatic-issue-2-implementation", issueNumber: 2 }),
		]);

		render(
			<DashboardScreen {...defaultProps} sessions={[session]} metrics={metrics} onSelectSession={onSelectSession} />,
		);

		const liveRow = Array.from(document.querySelectorAll(".activity-row")).find(
			(r) => r.textContent?.includes("#1"),
		);
		expect(liveRow).toBeDefined();
		fireEvent.click(liveRow!);

		expect(onSelectSession).toHaveBeenCalledTimes(1);
		expect(onSelectSession).toHaveBeenCalledWith(session);
	});
});
