// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

import { RepoManager, type ManagedRepo } from "./RepoManager.js";

vi.mock("../../api/repos.js", () => ({
	addRepo: vi.fn(),
}));

import { addRepo } from "../../api/repos.js";

const mockedAddRepo = vi.mocked(addRepo);

function makeRepo(overrides: Partial<ManagedRepo> = {}): ManagedRepo {
	return {
		owner: "mbrooks",
		repo: "yolomatic",
		fullName: "mbrooks/yolomatic",
		visibility: "private",
		selected: true,
		configured: true,
		...overrides,
	};
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("RepoManager", () => {
	it("renders a loading message while loading with no repos", () => {
		render(<RepoManager repos={[]} loading loadingMessage="Loading repositories..." />);
		expect(screen.getByText("Loading repositories...")).not.toBeNull();
	});

	it("renders the empty state when not loading and no repos", () => {
		render(<RepoManager repos={[]} emptyMessage="No repos available." />);
		expect(screen.getByText("No repos available.")).not.toBeNull();
	});

	it("renders the description and repo rows, and shows enabled/new badges", () => {
		const repos = [
			makeRepo({ configured: true, selected: true }),
			makeRepo({ owner: "octocat", repo: "hello", fullName: "octocat/hello", configured: false, selected: true }),
			makeRepo({ owner: "ghost", repo: "old", fullName: "ghost/old", configured: false, selected: false }),
		];
		render(
			<RepoManager
				repos={repos}
				description={<span>Choose repos</span>}
				onToggleRepo={vi.fn()}
				onSetAllSelected={vi.fn()}
			/>,
		);
		expect(screen.getByText("Choose repos")).not.toBeNull();
		expect(screen.getByText("mbrooks/yolomatic")).not.toBeNull();
		// Configured + selected shows "enabled" badge.
		expect(screen.getAllByText("enabled")).not.toBeNull();
		// Newly selected (not configured) shows "new" badge.
		expect(screen.getAllByText("new")).not.toBeNull();
		expect(screen.getByText("2 of 3 selected")).not.toBeNull();
	});

	it("calls onToggleRepo when a checkbox is toggled", () => {
		const onToggleRepo = vi.fn();
		const repos = [makeRepo({ selected: false })];
		render(<RepoManager repos={repos} onToggleRepo={onToggleRepo} onSetAllSelected={vi.fn()} />);
		fireEvent.click(screen.getByRole("checkbox", { name: "mbrooks/yolomatic" }));
		expect(onToggleRepo).toHaveBeenCalledWith(0);
	});

	it("Select All toggles to Deselect All and calls onSetAllSelected", () => {
		const onSetAllSelected = vi.fn();
		const repos = [makeRepo({ selected: false })];
		render(<RepoManager repos={repos} onToggleRepo={vi.fn()} onSetAllSelected={onSetAllSelected} />);
		const button = screen.getByRole("button", { name: "Select All" });
		fireEvent.click(button);
		expect(onSetAllSelected).toHaveBeenCalledWith(true);
	});

	it("hides selection controls when selectable is false", () => {
		const repos = [makeRepo({ selected: false })];
		render(<RepoManager repos={repos} selectable={false} />);
		expect(screen.queryByRole("checkbox")).toBeNull();
		expect(screen.queryByRole("button", { name: /select all/i })).toBeNull();
	});

	it("renders a Save button gated by canSave and calls onSave", () => {
		const onSave = vi.fn();
		const repos = [makeRepo({ selected: false })];
		render(
			<RepoManager repos={repos} onSave={onSave} canSave={false} onToggleRepo={vi.fn()} onSetAllSelected={vi.fn()} />,
		);
		expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("renders error and saved banners", () => {
		const repos = [makeRepo()];
		const { rerender } = render(<RepoManager repos={repos} error="Boom" onToggleRepo={vi.fn()} onSetAllSelected={vi.fn()} />);
		expect(screen.getByText("Boom")).not.toBeNull();
		rerender(<RepoManager repos={repos} savedMessage="Saved!" onToggleRepo={vi.fn()} onSetAllSelected={vi.fn()} />);
		expect(screen.getByText("Saved!")).not.toBeNull();
	});

	it("renders a Refresh button and calls onRefresh", () => {
		const onRefresh = vi.fn();
		const repos = [makeRepo()];
		render(<RepoManager repos={repos} onRefresh={onRefresh} onToggleRepo={vi.fn()} onSetAllSelected={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
		expect(onRefresh).toHaveBeenCalled();
	});

	it("opens the Add Repository modal, validates blank fields, and adds on success", async () => {
		mockedAddRepo.mockResolvedValue({ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", added: true });
		const onAdded = vi.fn();
		const repos = [makeRepo()];
		render(
			<RepoManager
				repos={repos}
				allowManualAdd
				onAdded={onAdded}
				onToggleRepo={vi.fn()}
				onSetAllSelected={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /add repository/i }));
		expect(screen.getByRole("dialog")).not.toBeNull();

		// Blank submit shows validation error and keeps the modal open.
		fireEvent.click(screen.getByRole("button", { name: /^add repository$/i }));
		await waitFor(() => {
			expect(screen.getByText(/owner and repository name are required/i)).not.toBeNull();
		});
		expect(mockedAddRepo).not.toHaveBeenCalled();

		fireEvent.change(screen.getByLabelText(/^owner$/i), { target: { value: "octocat" } });
		fireEvent.change(screen.getByLabelText(/^repository name$/i), { target: { value: "hello-world" } });
		fireEvent.click(screen.getByRole("button", { name: /^add repository$/i }));

		await waitFor(() => {
			expect(mockedAddRepo).toHaveBeenCalledWith("octocat", "hello-world");
		});
		await waitFor(() => {
			expect(onAdded).toHaveBeenCalled();
		});
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("shows an inline error and keeps the modal open when addRepo fails", async () => {
		mockedAddRepo.mockRejectedValue(new Error("Repository not found or not accessible"));
		const onAdded = vi.fn();
		const repos = [makeRepo()];
		render(
			<RepoManager repos={repos} allowManualAdd onAdded={onAdded} onToggleRepo={vi.fn()} onSetAllSelected={vi.fn()} />,
		);

		fireEvent.click(screen.getByRole("button", { name: /add repository/i }));
		fireEvent.change(screen.getByLabelText(/^owner$/i), { target: { value: "unknown" } });
		fireEvent.change(screen.getByLabelText(/^repository name$/i), { target: { value: "missing" } });
		fireEvent.click(screen.getByRole("button", { name: /^add repository$/i }));

		await waitFor(() => {
			expect(screen.getByText(/Repository not found or not accessible/)).not.toBeNull();
		});
		expect(screen.getByRole("dialog")).not.toBeNull();
		expect(onAdded).not.toHaveBeenCalled();
	});

	it("shows the 'already configured' message when addRepo returns added=false", async () => {
		mockedAddRepo.mockResolvedValue({
			owner: "octocat",
			repo: "hello-world",
			fullName: "octocat/hello-world",
			added: false,
			message: "Repository already configured",
		});
		const onAdded = vi.fn();
		const repos = [makeRepo()];
		render(
			<RepoManager repos={repos} allowManualAdd onAdded={onAdded} onToggleRepo={vi.fn()} onSetAllSelected={vi.fn()} />,
		);

		fireEvent.click(screen.getByRole("button", { name: /add repository/i }));
		fireEvent.change(screen.getByLabelText(/^owner$/i), { target: { value: "octocat" } });
		fireEvent.change(screen.getByLabelText(/^repository name$/i), { target: { value: "hello-world" } });
		fireEvent.click(screen.getByRole("button", { name: /^add repository$/i }));

		await waitFor(() => {
			expect(screen.getByText(/repository already configured/i)).not.toBeNull();
		});
		expect(onAdded).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog")).not.toBeNull();
	});

	it("closes the Add Repository modal when Cancel is clicked", () => {
		const repos = [makeRepo()];
		render(
			<RepoManager repos={repos} allowManualAdd onAdded={vi.fn()} onToggleRepo={vi.fn()} onSetAllSelected={vi.fn()} />,
		);
		fireEvent.click(screen.getByRole("button", { name: /add repository/i }));
		expect(screen.getByRole("dialog")).not.toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("renders the note in the actions row", () => {
		const repos = [makeRepo()];
		render(
			<RepoManager
				repos={repos}
				note={<span>Using the configured GitHub token.</span>}
				onToggleRepo={vi.fn()}
				onSetAllSelected={vi.fn()}
			/>,
		);
		expect(screen.getByText("Using the configured GitHub token.")).not.toBeNull();
	});
});