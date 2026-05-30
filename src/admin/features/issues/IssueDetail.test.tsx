// @vitest-environment happy-dom
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IssueDetail } from "./IssueDetail.js";

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
	it("renders empty state when no issue selected", () => {
		render(<IssueDetail selected={null} />);
		expect(screen.getByText("Select an issue from the list to view details.")).toBeDefined();
	});

	it("renders issue title with link", () => {
		render(<IssueDetail selected={mockIssue} />);
		const link = screen.getByRole("link");
		expect(link.textContent).toBe("#1 Bug report");
		expect(link.getAttribute("href")).toBe("https://github.com/mbrooks/tars/issues/1");
	});

	it("renders description", () => {
		render(<IssueDetail selected={mockIssue} />);
		expect(screen.getByText("Something is broken")).toBeDefined();
	});

	it("renders empty description message when body is empty", () => {
		render(<IssueDetail selected={{ ...mockIssue, body: "" }} />);
		expect(screen.getByText("No description provided.")).toBeDefined();
	});

	it("renders assignees as tags", () => {
		render(<IssueDetail selected={mockIssue} />);
		expect(screen.getByText("mbrooks")).toBeDefined();
	});

	it("renders unassigned message when no assignees", () => {
		render(<IssueDetail selected={{ ...mockIssue, assignees: [] }} />);
		expect(screen.getByText("Unassigned")).toBeDefined();
	});

	it("renders labels as tags", () => {
		render(<IssueDetail selected={mockIssue} />);
		expect(screen.getByText("bug")).toBeDefined();
		expect(screen.getByText("ui")).toBeDefined();
	});

	it("renders no labels message when no labels", () => {
		render(<IssueDetail selected={{ ...mockIssue, labels: [] }} />);
		expect(screen.getByText("No labels")).toBeDefined();
	});
});
