// @vitest-environment happy-dom
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Session } from "../../app/types.js";
import { SessionScreen } from "./SessionScreen.js";

vi.mock("../../hooks/useSessionLog.js", () => ({
	useSessionLog: vi.fn(() => ({
		status: "idle",
		logs: [],
		error: null,
		refreshing: false,
	})),
}));

function makeSession(issueNumber: number): Session {
	return {
		kind: "implementation",
		owner: "mbrooks",
		repo: "yolomatic",
		issueNumber,
		status: "working",
		title: `Issue ${issueNumber}`,
		body: "Body",
		summary: null,
		workspacePath: `/tmp/issue-${issueNumber}`,
		branch: `yolomatic/issue-${issueNumber}`,
		lastActivity: "2026-08-01T00:00:00.000Z",
		createdAt: "2026-08-01T00:00:00.000Z",
		prUrl: null,
		prNumber: null,
		risk: { suspectedMisroute: false, reasons: [], referencedIssueNumber: null },
		staleDetectedAt: null,
		staleReason: null,
		stale: null,
		taskStartedAt: null,
		taskFinishedAt: null,
		totalExecutionTimeMs: null,
	};
}

function setViewport(width: number) {
	window.innerWidth = width;
	window.innerHeight = 800;
	window.dispatchEvent(new Event("resize"));
}

describe("SessionScreen", () => {
	beforeEach(() => {
		setViewport(1024);
	});

	afterEach(() => {
		setViewport(1024);
		vi.clearAllMocks();
	});

	it("renders the list and detail panes on desktop", () => {
		const sessions = [makeSession(1), makeSession(2)];
		render(
			<SessionScreen
				sessions={sessions}
				selected={null}
				onSelect={vi.fn()}
				onMutate={vi.fn()}
				breadcrumbLabel="Sessions"
				onBack={vi.fn()}
				emptyMessage="No sessions."
			/>,
		);

		const workspace = document.querySelector(".workspace");
		expect(workspace).not.toBeNull();
		expect(workspace!.classList.contains("session-workspace")).toBe(true);
		expect(workspace!.classList.contains("has-selected")).toBe(false);

		expect(document.querySelector(".list-pane")).not.toBeNull();
		expect(document.querySelector(".detail-pane")).not.toBeNull();
		expect(document.querySelector(".session-back")).toBeNull();
	});

	it("uses the list-only mobile class state when no session is selected", () => {
		setViewport(768);
		const sessions = [makeSession(1), makeSession(2)];
		render(
			<SessionScreen
				sessions={sessions}
				selected={null}
				onSelect={vi.fn()}
				onMutate={vi.fn()}
				breadcrumbLabel="Sessions"
				onBack={vi.fn()}
				emptyMessage="No sessions."
			/>,
		);

		const workspace = document.querySelector(".workspace");
		expect(workspace).not.toBeNull();
		expect(workspace!.classList.contains("session-workspace")).toBe(true);
		expect(workspace!.classList.contains("has-selected")).toBe(false);

		expect(document.querySelector(".list-pane")).not.toBeNull();
		expect(document.querySelector(".detail-pane")).not.toBeNull();
		expect(document.querySelector(".session-back")).toBeNull();
	});

	it("uses the detail-only mobile class state when a session is selected", () => {
		setViewport(768);
		const sessions = [makeSession(1), makeSession(2)];
		const selected = sessions[0];
		render(
			<SessionScreen
				sessions={sessions}
				selected={selected}
				onSelect={vi.fn()}
				onMutate={vi.fn()}
				breadcrumbLabel="Sessions"
				onBack={vi.fn()}
				emptyMessage="No sessions."
				onDeselect={vi.fn()}
			/>,
		);

		const workspace = document.querySelector(".workspace");
		expect(workspace).not.toBeNull();
		expect(workspace!.classList.contains("session-workspace")).toBe(true);
		expect(workspace!.classList.contains("has-selected")).toBe(true);

		expect(document.querySelector(".list-pane")).not.toBeNull();
		expect(document.querySelector(".detail-pane")).not.toBeNull();
		expect(document.querySelector(".session-back")).not.toBeNull();
	});

	it("calls onDeselect when the mobile back button is clicked", () => {
		setViewport(768);
		const sessions = [makeSession(1)];
		const selected = sessions[0];
		const onDeselect = vi.fn();
		render(
			<SessionScreen
				sessions={sessions}
				selected={selected}
				onSelect={vi.fn()}
				onMutate={vi.fn()}
				breadcrumbLabel="Sessions"
				onBack={vi.fn()}
				emptyMessage="No sessions."
				onDeselect={onDeselect}
			/>,
		);

		const backButton = document.querySelector(".session-back");
		expect(backButton).not.toBeNull();
		fireEvent.click(backButton!);
		expect(onDeselect).toHaveBeenCalledTimes(1);
	});

	it("forwards session selection from the list pane", () => {
		const sessions = [makeSession(1), makeSession(2)];
		const onSelect = vi.fn();
		render(
			<SessionScreen
				sessions={sessions}
				selected={null}
				onSelect={onSelect}
				onMutate={vi.fn()}
				breadcrumbLabel="Sessions"
				onBack={vi.fn()}
				emptyMessage="No sessions."
			/>,
		);

		const rows = document.querySelectorAll(".list-row");
		expect(rows.length).toBe(2);
		fireEvent.click(rows[1]);
		expect(onSelect).toHaveBeenCalledWith(sessions[1]);
	});

	it("renders the empty state when there are no sessions", () => {
		render(
			<SessionScreen
				sessions={[]}
				selected={null}
				onSelect={vi.fn()}
				onMutate={vi.fn()}
				breadcrumbLabel="Sessions"
				onBack={vi.fn()}
				emptyMessage="Nothing here."
			/>,
		);

		expect(screen.getByText("Nothing here.")).toBeDefined();
		expect(document.querySelector(".workspace")).toBeNull();
	});
});
