// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { RepoScopedScreenShell } from "./RepoScopedScreenShell.js";

function renderShell(overrides: Partial<React.ComponentProps<typeof RepoScopedScreenShell>> = {}) {
	const props: React.ComponentProps<typeof RepoScopedScreenShell> = {
		owner: "mbrooks",
		repo: "tars",
		activeTab: "issues",
		onSelectTab: vi.fn(),
		onBack: vi.fn(),
		loading: false,
		loadingMessage: "Loading repo data...",
		empty: false,
		emptyMessage: "No repo data.",
		children: <section>Repo content</section>,
		...overrides,
	};
	render(<RepoScopedScreenShell {...props} />);
	return props;
}

describe("RepoScopedScreenShell", () => {
	it("renders shared repo navigation around workspace content", () => {
		const props = renderShell();

		expect(screen.getByText("mbrooks/tars")).toBeTruthy();
		expect(screen.getByText("Repo content")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));

		expect(props.onBack).toHaveBeenCalled();
	});

	it("renders the loading branch when empty", () => {
		renderShell({ loading: true, empty: true });

		expect(screen.getByText("Loading repo data...")).toBeTruthy();
		expect(screen.queryByText("Repo content")).toBeNull();
	});

	it("keeps workspace visible during reload", () => {
		renderShell({ loading: true, empty: false });

		expect(screen.queryByText("Loading repo data...")).toBeNull();
		expect(screen.getByText("Repo content")).toBeTruthy();
	});

	it("renders the empty branch with optional action", () => {
		renderShell({
			empty: true,
			emptyAction: <button type="button">Refresh</button>,
			emptyMessage: "No issues found.",
		});

		expect(screen.getByText("No issues found.")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
		expect(screen.queryByText("Repo content")).toBeNull();
	});
});
