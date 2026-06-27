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
			/>,
		);
		expect(screen.getByText("Sessions")).toBeDefined();
		expect(screen.getByText("Skills")).toBeDefined();
		expect(screen.getByText("Issues")).toBeDefined();
		expect(screen.queryByText("+ New Issue")).toBeNull();
	});

	it("marks the active tab", () => {
		render(
			<RepoTabs
				activeTab="issues"
				onSelectTab={vi.fn()}
			/>,
		);
		expect(screen.getByText("Issues").classList.contains("active")).toBe(true);
		expect(screen.getByText("Sessions").classList.contains("active")).toBe(false);
	});

	it("calls onSelectTab when a tab is clicked", () => {
		const onSelectTab = vi.fn();
		render(
			<RepoTabs
				activeTab="sessions"
				onSelectTab={onSelectTab}
			/>,
		);
		fireEvent.click(screen.getByText("Issues"));
		expect(onSelectTab).toHaveBeenCalledWith("issues");
	});
});
