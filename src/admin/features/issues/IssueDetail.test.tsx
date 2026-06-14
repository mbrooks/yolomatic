// @vitest-environment happy-dom
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { IssueDetail } from "./IssueDetail.js";

const mockAssignIssue = vi.fn();
const mockStartIssueSession = vi.fn();

vi.mock("../../api/issues.js", async () => {
	const actual = await vi.importActual<typeof import("../../api/issues.js")>("../../api/issues.js");
	return {
		...actual,
		assignIssue: (...args: unknown[]) => mockAssignIssue(...args),
		startIssueSession: (...args: unknown[]) => mockStartIssueSession(...args),
	};
});

const mockIssue = {
	number: 1,
	title: "Bug report",
	body: "Something is broken",
	state: "open",
	labels: ["bug", "ui"],
	assignees: ["mbrooks"],
	html_url: "https://github.com/mbrooks/tars/issues/1",
};

describe("IssueDetail", () => {
	beforeEach(() => {
		mockAssignIssue.mockReset();
		mockStartIssueSession.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders empty state when no issue selected", () => {
		render(<IssueDetail selected={null} owner="mbrooks" repo="tars" />);
		expect(screen.getByText("Select an issue from the list to view details.")).toBeDefined();
	});

	it("renders issue title with link", () => {
		render(<IssueDetail selected={mockIssue} owner="mbrooks" repo="tars" />);
		const link = screen.getByRole("link");
		expect(link.textContent).toBe("#1 Bug report");
		expect(link.getAttribute("href")).toBe("https://github.com/mbrooks/tars/issues/1");
	});

	it("renders description", () => {
		render(<IssueDetail selected={mockIssue} owner="mbrooks" repo="tars" />);
		expect(screen.getByText("Something is broken")).toBeDefined();
	});

	it("renders empty description message when body is empty", () => {
		render(<IssueDetail selected={{ ...mockIssue, body: "" }} owner="mbrooks" repo="tars" />);
		expect(screen.getByText("No description provided.")).toBeDefined();
	});

	it("renders assignees as tags", () => {
		render(<IssueDetail selected={mockIssue} owner="mbrooks" repo="tars" />);
		expect(screen.getByText("mbrooks")).toBeDefined();
	});

	it("renders unassigned message when no assignees", () => {
		render(<IssueDetail selected={{ ...mockIssue, assignees: [] }} owner="mbrooks" repo="tars" />);
		expect(screen.getByText("Unassigned")).toBeDefined();
	});

	it("does not show action buttons when issue has assignees", () => {
		render(<IssueDetail selected={mockIssue} owner="mbrooks" repo="tars" />);
		expect(screen.queryByText("Assign to TARS")).toBeNull();
		expect(screen.queryByText("Start Session")).toBeNull();
	});

	it("shows Assign to TARS and Start Session buttons when issue is unassigned", () => {
		render(<IssueDetail selected={{ ...mockIssue, assignees: [] }} owner="mbrooks" repo="tars" />);
		expect(screen.getByText("Assign to TARS")).toBeDefined();
		expect(screen.getByText("Start Session")).toBeDefined();
	});

	it("calls assignIssue and onAssignSuccess when Assign to TARS is clicked", async () => {
		mockAssignIssue.mockResolvedValue({ started: true, status: "working", message: "ok" });
		const onAssignSuccess = vi.fn();
		render(
			<IssueDetail
				selected={{ ...mockIssue, assignees: [] }}
				owner="mbrooks"
				repo="tars"
				onAssignSuccess={onAssignSuccess}
			/>,
		);
		const button = screen.getByText("Assign to TARS");
		fireEvent.click(button);
		await waitFor(() =>
			expect(mockAssignIssue).toHaveBeenCalledWith(
				"mbrooks",
				"tars",
				1,
				"Bug report",
				"Something is broken",
				["bug", "ui"],
			),
		);
		await waitFor(() => expect(onAssignSuccess).toHaveBeenCalled());
	});

	it("calls startIssueSession and onStartSessionSuccess when Start Session is clicked", async () => {
		mockStartIssueSession.mockResolvedValue({ started: true, status: "working", message: "ok" });
		const onStartSessionSuccess = vi.fn();
		render(
			<IssueDetail
				selected={{ ...mockIssue, assignees: [] }}
				owner="mbrooks"
				repo="tars"
				onStartSessionSuccess={onStartSessionSuccess}
			/>,
		);
		const button = screen.getByText("Start Session");
		fireEvent.click(button);
		await waitFor(() =>
			expect(mockStartIssueSession).toHaveBeenCalledWith(
				"mbrooks",
				"tars",
				1,
				"Bug report",
				"Something is broken",
				["bug", "ui"],
			),
		);
		await waitFor(() => expect(onStartSessionSuccess).toHaveBeenCalled());
	});

	it("shows error message when assignment fails", async () => {
		mockAssignIssue.mockRejectedValue(new Error("Network error"));
		render(
			<IssueDetail
				selected={{ ...mockIssue, assignees: [] }}
				owner="mbrooks"
				repo="tars"
			/>,
		);
		const button = screen.getByText("Assign to TARS");
		fireEvent.click(button);
		await waitFor(() => expect(screen.getByText("Network error")).toBeDefined());
	});

	it("shows Assigning... while assignment is in progress", async () => {
		mockAssignIssue.mockImplementation(() => new Promise(() => {}));
		render(
			<IssueDetail
				selected={{ ...mockIssue, assignees: [] }}
				owner="mbrooks"
				repo="tars"
			/>,
		);
		const button = screen.getByText("Assign to TARS");
		fireEvent.click(button);
		await waitFor(() => expect(screen.getByText("Assigning...")).toBeDefined());
	});

	it("shows error message when start session fails", async () => {
		mockStartIssueSession.mockRejectedValue(new Error("Start failed"));
		render(
			<IssueDetail
				selected={{ ...mockIssue, assignees: [] }}
				owner="mbrooks"
				repo="tars"
			/>,
		);
		const button = screen.getByText("Start Session");
		fireEvent.click(button);
		await waitFor(() => expect(screen.getByText("Start failed")).toBeDefined());
	});

	it("shows Starting... while start session is in progress", async () => {
		mockStartIssueSession.mockImplementation(() => new Promise(() => {}));
		render(
			<IssueDetail
				selected={{ ...mockIssue, assignees: [] }}
				owner="mbrooks"
				repo="tars"
			/>,
		);
		const button = screen.getByText("Start Session");
		fireEvent.click(button);
		await waitFor(() => expect(screen.getByText("Starting...")).toBeDefined());
	});

	it("renders labels as tags", () => {
		render(<IssueDetail selected={mockIssue} owner="mbrooks" repo="tars" />);
		expect(screen.getByText("bug")).toBeDefined();
		expect(screen.getByText("ui")).toBeDefined();
	});

	it("renders no labels message when no labels", () => {
		render(<IssueDetail selected={{ ...mockIssue, labels: [] }} owner="mbrooks" repo="tars" />);
		expect(screen.getByText("No labels")).toBeDefined();
	});

	it("resets assigning state when selected issue changes", async () => {
		mockAssignIssue.mockImplementation(() => new Promise(() => {}));
		const { rerender } = render(
			<IssueDetail
				selected={{ ...mockIssue, number: 1, assignees: [] }}
				owner="mbrooks"
				repo="tars"
			/>,
		);
		fireEvent.click(screen.getByText("Assign to TARS"));
		await waitFor(() => expect(screen.getByText("Assigning...")).toBeDefined());

		rerender(
			<IssueDetail
				selected={{ ...mockIssue, number: 2, assignees: [] }}
				owner="mbrooks"
				repo="tars"
			/>,
		);
		expect(screen.queryByText("Assigning...")).toBeNull();
		expect(screen.getByText("Assign to TARS")).toBeDefined();
	});

	it("resets start session state when selected issue changes", async () => {
		mockStartIssueSession.mockImplementation(() => new Promise(() => {}));
		const { rerender } = render(
			<IssueDetail
				selected={{ ...mockIssue, number: 1, assignees: [] }}
				owner="mbrooks"
				repo="tars"
			/>,
		);
		fireEvent.click(screen.getByText("Start Session"));
		await waitFor(() => expect(screen.getByText("Starting...")).toBeDefined());

		rerender(
			<IssueDetail
				selected={{ ...mockIssue, number: 2, assignees: [] }}
				owner="mbrooks"
				repo="tars"
			/>,
		);
		expect(screen.queryByText("Starting...")).toBeNull();
		expect(screen.getByText("Start Session")).toBeDefined();
	});

	it("resets error states when selected issue changes", async () => {
		mockAssignIssue.mockRejectedValue(new Error("Network error"));
		mockStartIssueSession.mockRejectedValue(new Error("Start failed"));
		const { rerender } = render(
			<IssueDetail
				selected={{ ...mockIssue, number: 1, assignees: [] }}
				owner="mbrooks"
				repo="tars"
			/>,
		);
		fireEvent.click(screen.getByText("Assign to TARS"));
		fireEvent.click(screen.getByText("Start Session"));
		await waitFor(() => expect(screen.getByText("Network error")).toBeDefined());
		await waitFor(() => expect(screen.getByText("Start failed")).toBeDefined());

		rerender(
			<IssueDetail
				selected={{ ...mockIssue, number: 2, assignees: [] }}
				owner="mbrooks"
				repo="tars"
			/>,
		);
		expect(screen.queryByText("Network error")).toBeNull();
		expect(screen.queryByText("Start failed")).toBeNull();
	});

	it("shows TARS as optimistic assignee after successful assignment", async () => {
		mockAssignIssue.mockResolvedValue({ started: true, status: "working", message: "ok" });
		render(
			<IssueDetail
				selected={{ ...mockIssue, assignees: [] }}
				owner="mbrooks"
				repo="tars"
			/>,
		);
		const button = screen.getByText("Assign to TARS");
		fireEvent.click(button);
		await waitFor(() => expect(screen.getByText("TARS")).toBeDefined());
		expect(screen.queryByText("Assign to TARS")).toBeNull();
		expect(screen.queryByText("Start Session")).toBeNull();
	});

	it("resets optimistic assignee when selected issue changes", async () => {
		mockAssignIssue.mockResolvedValue({ started: true, status: "working", message: "ok" });
		const { rerender } = render(
			<IssueDetail
				selected={{ ...mockIssue, number: 1, assignees: [] }}
				owner="mbrooks"
				repo="tars"
			/>,
		);
		fireEvent.click(screen.getByText("Assign to TARS"));
		await waitFor(() => expect(screen.getByText("TARS")).toBeDefined());

		rerender(
			<IssueDetail
				selected={{ ...mockIssue, number: 2, assignees: [] }}
				owner="mbrooks"
				repo="tars"
			/>,
		);
		expect(screen.queryByText("TARS")).toBeNull();
		expect(screen.getByText("Unassigned")).toBeDefined();
		expect(screen.getByText("Assign to TARS")).toBeDefined();
	});
});
