// @vitest-environment happy-dom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RepoTabs } from "./RepoTabs.js";

describe("RepoTabs", () => {
	it("renders tabs in Sessions, Issues, Skills, Settings order", () => {
		render(
			<RepoTabs
				activeTab="sessions"
				onSelectTab={vi.fn()}
			/>,
		);
		const buttons = screen.getAllByRole("button");
		expect(buttons.map((b) => b.textContent)).toEqual(["Sessions", "Issues", "Skills", "Settings"]);
	});

	it("marks the active tab", () => {
		render(
			<RepoTabs
				activeTab="sessions"
				onSelectTab={vi.fn()}
			/>,
		);
		expect(screen.getByText("Sessions").classList.contains("active")).toBe(true);
		expect(screen.getByText("Issues").classList.contains("active")).toBe(false);
		expect(screen.getByText("Skills").classList.contains("active")).toBe(false);
		expect(screen.getByText("Settings").classList.contains("active")).toBe(false);
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
