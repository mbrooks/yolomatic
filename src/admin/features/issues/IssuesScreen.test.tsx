// @vitest-environment happy-dom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { IssuesScreen } from "./IssuesScreen.js";

const mockIssuesRef = {
	current: [
		{ number: 1, title: "Bug", body: "desc", state: "open", labels: ["bug"], assignees: [], html_url: "https://github.com/o/r/issues/1" },
	],
};

vi.mock("./useRepoIssues.js", () => ({
	useRepoIssues: vi.fn((owner: string, repo: string) => {
		if (owner === "empty" && repo === "repo") {
			return { issues: [], loading: false, reload: vi.fn() };
		}
		if (owner === "loading" && repo === "repo") {
			return { issues: [], loading: true, reload: vi.fn() };
		}
		return {
			issues: mockIssuesRef.current,
			loading: false,
			reload: vi.fn(),
		};
	}),
}));

describe("IssuesScreen", () => {
	it("renders loading state", () => {
		render(
			<IssuesScreen
				owner="loading"
				repo="repo"
				onBack={vi.fn()}
				onSelectTab={vi.fn()}
			/>,
		);
		expect(screen.getByText("Loading issues...")).toBeDefined();
	});

	it("renders empty state when no issues", () => {
		render(
			<IssuesScreen
				owner="empty"
				repo="repo"
				onBack={vi.fn()}
				onSelectTab={vi.fn()}
			/>,
		);
		expect(screen.getByText("No open issues for this repository.")).toBeDefined();
	});

	it("renders issue list and detail panes", async () => {
		render(
			<IssuesScreen
				owner="mbrooks"
				repo="tars"
				onBack={vi.fn()}
				onSelectTab={vi.fn()}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText("Bug")).toBeDefined();
		});
	});

	it("renders the Issues tab as active", () => {
		render(
			<IssuesScreen
				owner="mbrooks"
				repo="tars"
				onBack={vi.fn()}
				onSelectTab={vi.fn()}
			/>,
		);
		const tabs = screen.getAllByRole("button");
		const issuesTab = tabs.find((t) => t.textContent === "Issues");
		expect(issuesTab?.classList.contains("active")).toBe(true);
	});

	it("keeps selected issue in sync when issues reload", async () => {
		const { rerender } = render(
			<IssuesScreen
				owner="mbrooks"
				repo="tars"
				onBack={vi.fn()}
				onSelectTab={vi.fn()}
			/>,
		);
		await waitFor(() => {
			expect(screen.getByText("Bug")).toBeDefined();
		});
		fireEvent.click(screen.getByText("Bug"));
		expect(screen.getByText("Assign to Yeetomatic")).toBeDefined();

		mockIssuesRef.current = [
			{ number: 1, title: "Bug", body: "desc", state: "open", labels: ["bug"], assignees: ["yeetomatic"], html_url: "https://github.com/o/r/issues/1" },
		];
		rerender(
			<IssuesScreen
				owner="mbrooks"
				repo="tars"
				onBack={vi.fn()}
				onSelectTab={vi.fn()}
			/>,
		);
		await waitFor(() => {
			expect(screen.queryByText("Assign to Yeetomatic")).toBeNull();
		});
		expect(screen.getByText("yeetomatic")).toBeDefined();
	});
});
