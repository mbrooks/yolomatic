// @vitest-environment happy-dom
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { IssueDetail } from "./IssueDetail.js";
import type { Session } from "../../app/types.js";

const mockAssignIssue = vi.fn();
const mockUseSessionLog = vi.fn();

vi.mock("../../api/issues.js", async () => {
	const actual =
		await vi.importActual<typeof import("../../api/issues.js")>("../../api/issues.js");
	return {
		...actual,
		assignIssue: (...args: unknown[]) => mockAssignIssue(...args),
	};
});

vi.mock("../../hooks/useSessionLog.js", () => ({
	useSessionLog: (...args: unknown[]) => mockUseSessionLog(...args),
}));

vi.mock("../sessions/SessionLogPanel.js", () => ({
	SessionLogPanel: () => <div data-testid="session-log-panel">Log Panel</div>,
}));

const mockIssue = {
	number: 1,
	title: "Bug report",
	body: "Something is broken",
	state: "open",
	labels: ["bug", "ui"],
	assignees: ["mbrooks"],
	html_url: "https://github.com/mbrooks/tars/issues/1",
};

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		owner: "mbrooks",
		repo: "tars",
		issueNumber: 1,
		status: "working",
		workspacePath: "/ws/1",
		branch: "tars/issue-1",
		lastActivity: new Date().toISOString(),
		createdAt: new Date(Date.now() - 3600000).toISOString(),
		prUrl: null,
		prNumber: null,
		risk: {
			suspectedMisroute: false,
			reasons: [],
			referencedIssueNumber: null,
		},
		staleDetectedAt: null,
		staleReason: null,
		stale: null,
		sessionType: "github_issue",
		...overrides,
	};
}

describe("IssueDetail", () => {
	beforeEach(() => {
		mockAssignIssue.mockReset();
		mockUseSessionLog.mockReturnValue({
			status: "idle",
			logs: [],
			error: null,
			refreshing: false,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders empty state when no issue selected", () => {
		render(
			<IssueDetail
				selected={null}
				owner="mbrooks"
				repo="tars"
				sessions={[]}
			/>,
		);
		expect(
			screen.getByText("Select an issue from the list to view details."),
		).toBeDefined();
	});

	it("renders issue title with link", () => {
		render(
			<IssueDetail
				selected={mockIssue}
				owner="mbrooks"
				repo="tars"
				sessions={[]}
			/>,
		);
		const link = screen.getByRole("link");
		expect(link.textContent).toBe("#1 Bug report");
		expect(link.getAttribute("href")).toBe(
			"https://github.com/mbrooks/tars/issues/1",
		);
	});

	it("renders description", () => {
		render(
			<IssueDetail
				selected={mockIssue}
				owner="mbrooks"
				repo="tars"
				sessions={[]}
			/>,
		);
		expect(screen.getByText("Something is broken")).toBeDefined();
	});

	it("renders empty description message when body is empty", () => {
		render(
			<IssueDetail
				selected={{ ...mockIssue, body: "" }}
				owner="mbrooks"
				repo="tars"
				sessions={[]}
			/>,
		);
		expect(screen.getByText("No description provided.")).toBeDefined();
	});

	it("renders assignees as tags", () => {
		render(
			<IssueDetail
				selected={mockIssue}
				owner="mbrooks"
				repo="tars"
				sessions={[]}
			/>,
		);
		expect(screen.getByText("mbrooks")).toBeDefined();
	});

	it("renders unassigned message when no assignees", () => {
		render(
			<IssueDetail
				selected={{ ...mockIssue, assignees: [] }}
				owner="mbrooks"
				repo="tars"
				sessions={[]}
			/>,
		);
		expect(screen.getByText("Unassigned")).toBeDefined();
	});

	it("does not show Assign to TARS button when issue has assignees", () => {
		render(
			<IssueDetail
				selected={mockIssue}
				owner="mbrooks"
				repo="tars"
				sessions={[]}
			/>,
		);
		expect(screen.queryByText("Assign to TARS")).toBeNull();
	});

	it("shows Assign to TARS button when issue is unassigned", () => {
		render(
			<IssueDetail
				selected={{ ...mockIssue, assignees: [] }}
				owner="mbrooks"
				repo="tars"
				sessions={[]}
			/>,
		);
		expect(screen.getByText("Assign to TARS")).toBeDefined();
	});

	it("calls assignIssue and onAssignSuccess when Assign to TARS is clicked", async () => {
		mockAssignIssue.mockResolvedValue(undefined);
		const onAssignSuccess = vi.fn();
		render(
			<IssueDetail
				selected={{ ...mockIssue, assignees: [] }}
				owner="mbrooks"
				repo="tars"
				sessions={[]}
				onAssignSuccess={onAssignSuccess}
			/>,
		);
		const button = screen.getByText("Assign to TARS");
		fireEvent.click(button);
		await waitFor(() =>
			expect(mockAssignIssue).toHaveBeenCalledWith("mbrooks", "tars", 1),
		);
		await waitFor(() => expect(onAssignSuccess).toHaveBeenCalled());
	});

	it("shows error message when assignment fails", async () => {
		mockAssignIssue.mockRejectedValue(new Error("Network error"));
		render(
			<IssueDetail
				selected={{ ...mockIssue, assignees: [] }}
				owner="mbrooks"
				repo="tars"
				sessions={[]}
			/>,
		);
		const button = screen.getByText("Assign to TARS");
		fireEvent.click(button);
		await waitFor(() =>
			expect(screen.getByText("Network error")).toBeDefined(),
		);
	});

	it("shows Assigning... while assignment is in progress", async () => {
		mockAssignIssue.mockImplementation(() => new Promise(() => {}));
		render(
			<IssueDetail
				selected={{ ...mockIssue, assignees: [] }}
				owner="mbrooks"
				repo="tars"
				sessions={[]}
			/>,
		);
		const button = screen.getByText("Assign to TARS");
		fireEvent.click(button);
		await waitFor(() =>
			expect(screen.getByText("Assigning...")).toBeDefined(),
		);
	});

	it("renders labels as tags", () => {
		render(
			<IssueDetail
				selected={mockIssue}
				owner="mbrooks"
				repo="tars"
				sessions={[]}
			/>,
		);
		expect(screen.getByText("bug")).toBeDefined();
		expect(screen.getByText("ui")).toBeDefined();
	});

	it("renders no labels message when no labels", () => {
		render(
			<IssueDetail
				selected={{ ...mockIssue, labels: [] }}
				owner="mbrooks"
				repo="tars"
				sessions={[]}
			/>,
		);
		expect(screen.getByText("No labels")).toBeDefined();
	});

	it("renders no session message when no matching session", () => {
		render(
			<IssueDetail
				selected={mockIssue}
				owner="mbrooks"
				repo="tars"
				sessions={[]}
			/>,
		);
		expect(screen.getByText("No TARS session for this issue.")).toBeDefined();
	});

	it("renders primary session status and details", () => {
		const session = makeSession({ status: "working" });
		render(
			<IssueDetail
				selected={mockIssue}
				owner="mbrooks"
				repo="tars"
				sessions={[session]}
			/>,
		);
		expect(screen.getByText("working")).toBeDefined();
		expect(screen.getByText("tars/issue-1")).toBeDefined();
		expect(screen.getByText("/ws/1")).toBeDefined();
	});

	it("shows View Session button when session exists and handler provided", () => {
		const session = makeSession();
		const onSelectSession = vi.fn();
		render(
			<IssueDetail
				selected={mockIssue}
				owner="mbrooks"
				repo="tars"
				sessions={[session]}
				onSelectSession={onSelectSession}
			/>,
		);
		const button = screen.getByText("View Session");
		expect(button).toBeDefined();
		fireEvent.click(button);
		expect(onSelectSession).toHaveBeenCalledWith(session);
	});

	it("does not show View Session button when handler is missing", () => {
		const session = makeSession();
		render(
			<IssueDetail
				selected={mockIssue}
				owner="mbrooks"
				repo="tars"
				sessions={[session]}
			/>,
		);
		expect(screen.queryByText("View Session")).toBeNull();
	});

	it("renders PR link when session has a PR", () => {
		const session = makeSession({
			prUrl: "https://github.com/mbrooks/tars/pull/42",
			prNumber: 42,
		});
		render(
			<IssueDetail
				selected={mockIssue}
				owner="mbrooks"
				repo="tars"
				sessions={[session]}
			/>,
		);
		const link = screen.getByText("PR #42");
		expect(link).toBeDefined();
		expect(link.getAttribute("href")).toBe(
			"https://github.com/mbrooks/tars/pull/42",
		);
	});

	it("shows session history when multiple sessions exist", () => {
		const sessions = [
			makeSession({
				status: "working",
				lastActivity: new Date(Date.now() - 1000).toISOString(),
			}),
			makeSession({
				status: "complete",
				lastActivity: new Date(Date.now() - 86400000).toISOString(),
			}),
		];
		render(
			<IssueDetail
				selected={mockIssue}
				owner="mbrooks"
				repo="tars"
				sessions={sessions}
			/>,
		);
		expect(screen.getByText("Session History")).toBeDefined();
		expect(screen.getByText("complete")).toBeDefined();
	});

	it("renders log panel when primary session exists", () => {
		const session = makeSession();
		render(
			<IssueDetail
				selected={mockIssue}
				owner="mbrooks"
				repo="tars"
				sessions={[session]}
			/>,
		);
		expect(screen.getByTestId("session-log-panel")).toBeDefined();
	});

	it("filters sessions by owner, repo and issue number", () => {
		const session = makeSession({ issueNumber: 2 });
		render(
			<IssueDetail
				selected={mockIssue}
				owner="mbrooks"
				repo="tars"
				sessions={[session]}
			/>,
		);
		expect(screen.getByText("No TARS session for this issue.")).toBeDefined();
	});
});
