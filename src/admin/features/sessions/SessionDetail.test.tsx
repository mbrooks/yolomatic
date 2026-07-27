// @vitest-environment happy-dom
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { LogLoadState } from "../../hooks/useSessionLog.js";
import type { Session } from "../../app/types.js";

vi.mock("../../hooks/useSessionLog.js", () => ({
	useSessionLog: vi.fn((): LogLoadState => ({
		status: "idle",
		logs: [],
		error: null,
		refreshing: false,
	})),
}));

vi.mock("../../api/sessions.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/sessions.js")>("../../api/sessions.js");
	return {
		...actual,
		sendSessionCommand: vi.fn(async () => ({ ok: true, message: "ok" })),
	};
});

import { SessionDetail } from "./SessionDetail.js";
import { useSessionLog } from "../../hooks/useSessionLog.js";

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		owner: "mbrooks",
		repo: "tars",
		issueNumber: 42,
		status: "working",
		title: null,
		body: null,
		summary: null,
		workspacePath: "/ws/42",
		branch: "tars/issue-42",
		lastActivity: "2026-01-01T00:00:00Z",
		createdAt: "2026-01-01T00:00:00Z",
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

describe("SessionDetail", () => {
	beforeEach(() => {
		vi.mocked(useSessionLog).mockReturnValue({
			status: "idle",
			logs: [],
			error: null,
			refreshing: false,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("renders empty state when no session is selected", () => {
		render(<SessionDetail selected={null} onMutate={vi.fn()} />);
		expect(screen.getByText("Select a session from the list to view details and actions.")).toBeDefined();
	});

	it("renders the issue summary as the first section above the detail title", () => {
		const session = makeSession({
			title: "Fix the flux capacitor",
			summary: "The flux capacitor needs recalibration.",
		});
		render(<SessionDetail selected={session} onMutate={vi.fn()} />);

		const pane = document.querySelector(".detail-pane");
		expect(pane).not.toBeNull();
		const children = Array.from(pane!.children);
		expect(children.length).toBeGreaterThan(0);
		expect(children[0].classList.contains("issue-summary")).toBe(true);

		// Detail title still present after the summary block
		const title = pane!.querySelector(".detail-title");
		expect(title?.textContent).toContain("mbrooks/tars#42");
	});

	it("renders the issue title as a link to the GitHub issue", () => {
		const session = makeSession({
			title: "Fix the flux capacitor",
			summary: "The flux capacitor needs recalibration.",
		});
		render(<SessionDetail selected={session} onMutate={vi.fn()} />);

		const summary = document.querySelector(".issue-summary");
		const summaryTitle = summary!.querySelector("a.issue-summary-title");
		expect(summaryTitle).not.toBeNull();
		expect(summaryTitle!.textContent).toBe("#42 Fix the flux capacitor");
		expect(summaryTitle!.getAttribute("href")).toBe("https://github.com/mbrooks/tars/issues/42");
	});

	it("prefers summary over body for the excerpt", () => {
		const session = makeSession({
			title: "Fix the flux capacitor",
			summary: "Short summary text.",
			body: "A much longer body that should be ignored because summary is present.",
		});
		render(<SessionDetail selected={session} onMutate={vi.fn()} />);

		expect(screen.getByText(/Short summary text\./)).toBeDefined();
		expect(screen.queryByText("A much longer body that should be ignored because summary is present.")).toBeNull();
	});

	it("truncates a long body and shows a 'more' link to GitHub", () => {
		const longBody = "x".repeat(500);
		const session = makeSession({ title: "Long issue", body: longBody });
		render(<SessionDetail selected={session} onMutate={vi.fn()} />);

		const moreLink = screen.getByText("more");
		expect(moreLink.tagName).toBe("A");
		expect(moreLink.getAttribute("href")).toBe("https://github.com/mbrooks/tars/issues/42");

		const bodyEl = document.querySelector(".issue-summary-body");
		expect(bodyEl?.textContent).toContain("x".repeat(300));
		// Should be truncated (not the full 500 chars)
		expect(bodyEl?.textContent?.includes("x".repeat(500))).toBe(false);
	});

	it("does not show a 'more' link when body is short enough", () => {
		const session = makeSession({ title: "Short issue", body: "A short body." });
		render(<SessionDetail selected={session} onMutate={vi.fn()} />);

		expect(screen.queryByText("more")).toBeNull();
		expect(screen.getByText(/A short body\./)).toBeDefined();
	});

	it("shows a fallback message when no issue content is available", () => {
		const session = makeSession({ title: null, body: null, summary: null });
		render(<SessionDetail selected={session} onMutate={vi.fn()} />);

		expect(screen.getByText("No issue description available.")).toBeDefined();
		// Issue summary section should still be the first child
		const pane = document.querySelector(".detail-pane");
		const children = Array.from(pane!.children);
		expect(children[0].classList.contains("issue-summary")).toBe(true);
	});

	it("treats whitespace-only content as missing", () => {
		const session = makeSession({ title: "   ", body: "   \n\t  ", summary: "  " });
		render(<SessionDetail selected={session} onMutate={vi.fn()} />);

		expect(screen.getByText("No issue description available.")).toBeDefined();
	});

	it("renders the title link even when body and summary are missing", () => {
		const session = makeSession({ title: "Title only", body: null, summary: null });
		render(<SessionDetail selected={session} onMutate={vi.fn()} />);

		const summary = document.querySelector(".issue-summary");
		const titleLink = summary!.querySelector("a.issue-summary-title");
		expect(titleLink).not.toBeNull();
		expect(titleLink!.textContent).toBe("#42 Title only");
		expect(titleLink!.getAttribute("href")).toBe("https://github.com/mbrooks/tars/issues/42");
		expect(screen.queryByText("more")).toBeNull();
	});

	it("renders the issue number link when title is missing but body is present", () => {
		const session = makeSession({ title: null, body: "Some body content here." });
		render(<SessionDetail selected={session} onMutate={vi.fn()} />);

		const summary = document.querySelector(".issue-summary");
		expect(summary).not.toBeNull();
		const numberLink = summary!.querySelector("a.issue-summary-title");
		expect(numberLink).not.toBeNull();
		expect(numberLink!.textContent).toBe("#42");
		expect(numberLink!.getAttribute("href")).toBe("https://github.com/mbrooks/tars/issues/42");
		expect(screen.getByText(/Some body content here\./)).toBeDefined();
	});

	it("renders the existing detail-title heading", () => {
		const session = makeSession({ title: "Fix the flux capacitor" });
		render(<SessionDetail selected={session} onMutate={vi.fn()} />);

		expect(screen.getByText("mbrooks/tars#42")).toBeDefined();
	});

	it("renders an issue link inside the Summary grid", () => {
		const session = makeSession({ title: "Fix the flux capacitor" });
		render(<SessionDetail selected={session} onMutate={vi.fn()} />);

		const summaryGrid = document.querySelector(".detail-grid");
		expect(summaryGrid).not.toBeNull();
		const issueLink = summaryGrid!.querySelector("a[href=\"https://github.com/mbrooks/tars/issues/42\"]");
		expect(issueLink).not.toBeNull();
	});

	it("invokes onMutate after a successful action command", async () => {
		const onMutate = vi.fn();
		const session = makeSession({ status: "working" });
		const { sendSessionCommand } = await import("../../api/sessions.js");
		vi.mocked(sendSessionCommand).mockResolvedValue({ ok: true, message: "paused" });

		// window.confirm is not available in happy-dom by default in some versions; stub it.
		window.confirm = () => true;

		render(<SessionDetail selected={session} onMutate={onMutate} />);

		const pauseButton = screen.getByText("Pause");
		fireEvent.click(pauseButton);

		await vi.waitFor(() => expect(onMutate).toHaveBeenCalled());
	});
});