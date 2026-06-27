// @vitest-environment happy-dom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RepoTabs } from "./RepoTabs.js";

describe("RepoTabs", () => {
	it("renders all tabs", () => {
		render(
			<RepoTabs
				activeTab="sessions"
				onSelectTab={vi.fn()}
				onNewIssue={vi.fn()}
			/>,
		);
		expect(screen.getByText("Sessions")).toBeDefined();
		expect(screen.getByText("Skills")).toBeDefined();
		expect(screen.getByText("Issues")).toBeDefined();
		expect(screen.getByText("+ New Issue")).toBeDefined();
	});

	it("marks the active tab", () => {
		render(
			<RepoTabs
				activeTab="issues"
				onSelectTab={vi.fn()}
				onNewIssue={vi.fn()}
			/>,
		);
		expect(screen.getByText("Issues").classList.contains("active")).toBe(true);
		expect(screen.getByText("Sessions").classList.contains("active")).toBe(false);
	});

	it("does not render + New Issue when onNewIssue is missing", () => {
		render(
			<RepoTabs
				activeTab="sessions"
				onSelectTab={vi.fn()}
			/>,
		);
		expect(screen.queryByText("+ New Issue")).toBeNull();
	});

	it("calls onSelectTab when a tab is clicked", () => {
		const onSelectTab = vi.fn();
		render(
			<RepoTabs
				activeTab="sessions"
				onSelectTab={onSelectTab}
				onNewIssue={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByText("Issues"));
		expect(onSelectTab).toHaveBeenCalledWith("issues");
	});

	it("calls onNewIssue when + New Issue is clicked", () => {
		const onNewIssue = vi.fn();
		render(
			<RepoTabs
				activeTab="sessions"
				onSelectTab={vi.fn()}
				onNewIssue={onNewIssue}
			/>,
		);
		fireEvent.click(screen.getByText("+ New Issue"));
		expect(onNewIssue).toHaveBeenCalled();
	});
});
