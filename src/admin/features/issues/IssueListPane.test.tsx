// @vitest-environment happy-dom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IssueListPane } from "./IssueListPane.js";

const mockIssues = [
	{ number: 1, title: "Bug report", body: "desc", state: "open", labels: ["bug", "ui"], assignees: ["mbrooks"], html_url: "https://github.com/mbrooks/yolomatic/issues/1" },
	{ number: 2, title: "Feature request", body: "", state: "open", labels: [], assignees: [], html_url: "https://github.com/mbrooks/yolomatic/issues/2" },
];

describe("IssueListPane", () => {
	it("renders issue rows with number, title and labels", () => {
		render(
			<IssueListPane
				issues={mockIssues}
				selected={null}
				onSelect={vi.fn()}
			/>,
		);
		expect(screen.getByText("#1")).toBeDefined();
		expect(screen.getByText("Bug report")).toBeDefined();
		expect(screen.getByText("bug, ui")).toBeDefined();
		expect(screen.getByText("#2")).toBeDefined();
		expect(screen.getByText("Feature request")).toBeDefined();
		expect(screen.getByText("—")).toBeDefined();
	});

	it("calls onSelect when a row is clicked", () => {
		const onSelect = vi.fn();
		render(
			<IssueListPane
				issues={mockIssues}
				selected={null}
				onSelect={onSelect}
			/>,
		);
		fireEvent.click(screen.getByText("Bug report"));
		expect(onSelect).toHaveBeenCalledWith(mockIssues[0]);
	});

	it("applies selected class to the selected issue", () => {
		const { container } = render(
			<IssueListPane
				issues={mockIssues}
				selected={mockIssues[0]}
				onSelect={vi.fn()}
			/>,
		);
		const rows = container.querySelectorAll(".list-row");
		expect(rows[0].classList.contains("selected")).toBe(true);
		expect(rows[1].classList.contains("selected")).toBe(false);
	});

	it("calls onSelect on Enter key", () => {
		const onSelect = vi.fn();
		render(
			<IssueListPane
				issues={mockIssues}
				selected={null}
				onSelect={onSelect}
			/>,
		);
		const row = screen.getByText("Bug report").closest(".list-row");
		fireEvent.keyDown(row!, { key: "Enter" });
		expect(onSelect).toHaveBeenCalledWith(mockIssues[0]);
	});

	it("calls onSelect on Space key", () => {
		const onSelect = vi.fn();
		render(
			<IssueListPane
				issues={mockIssues}
				selected={null}
				onSelect={onSelect}
			/>,
		);
		const row = screen.getByText("Bug report").closest(".list-row");
		fireEvent.keyDown(row!, { key: " " });
		expect(onSelect).toHaveBeenCalledWith(mockIssues[0]);
	});
});
