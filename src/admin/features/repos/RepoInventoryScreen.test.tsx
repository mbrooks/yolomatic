// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { RepoInventoryScreen } from "./RepoInventoryScreen.js";
import type { RepoSummary } from "../../app/types.js";

vi.mock("../../api/repos.js", () => ({
	scanRepos: vi.fn(),
	addRepo: vi.fn(),
}));

import { scanRepos, addRepo } from "../../api/repos.js";

const mockedScanRepos = vi.mocked(scanRepos);
const mockedAddRepo = vi.mocked(addRepo);

function makeRepo(overrides: Partial<RepoSummary> = {}): RepoSummary {
	return {
		owner: "mbrooks",
		repo: "tars",
		sessionCount: 1,
		activeCount: 0,
		lastActivity: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

const defaultProps = {
	repos: [] as RepoSummary[],
	onSelectRepo: vi.fn(),
	onBack: vi.fn(),
	onRescanComplete: vi.fn(),
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("RepoInventoryScreen", () => {
	it("renders empty state when no repos", () => {
		render(<RepoInventoryScreen {...defaultProps} />);
		expect(screen.getByText("No repositories have been used yet.")).not.toBeNull();
	});

	it("renders repo rows", () => {
		const repos = [
			makeRepo({ owner: "mbrooks", repo: "tars", sessionCount: 2 }),
			makeRepo({ owner: "octocat", repo: "hello-world", sessionCount: 0 }),
		];
		render(<RepoInventoryScreen {...defaultProps} repos={repos} />);

		expect(screen.getByText("mbrooks/tars")).not.toBeNull();
		expect(screen.getByText("octocat/hello-world")).not.toBeNull();
	});

	it("calls onSelectRepo when a row is clicked", () => {
		const onSelectRepo = vi.fn();
		const repos = [makeRepo()];
		render(<RepoInventoryScreen {...defaultProps} repos={repos} onSelectRepo={onSelectRepo} />);

		fireEvent.click(screen.getByText("mbrooks/tars"));
		expect(onSelectRepo).toHaveBeenCalledWith("mbrooks", "tars");
	});

	it("shows scanning state and calls scanRepos when Rescan is clicked", async () => {
		mockedScanRepos.mockResolvedValue({ repos: [], added: 0 });
		const onRescanComplete = vi.fn();
		render(<RepoInventoryScreen {...defaultProps} onRescanComplete={onRescanComplete} />);

		const button = screen.getByRole("button", { name: /rescan/i });
		fireEvent.click(button);

		await waitFor(() => {
			expect(screen.getByRole("button", { name: /scanning/i })).not.toBeNull();
		});

		await waitFor(() => {
			expect(onRescanComplete).toHaveBeenCalled();
		});
	});

	it("displays error when scanRepos fails", async () => {
		mockedScanRepos.mockRejectedValue(new Error("Token invalid"));
		render(<RepoInventoryScreen {...defaultProps} />);

		const button = screen.getByRole("button", { name: /rescan/i });
		fireEvent.click(button);

		await waitFor(() => {
			expect(screen.getByText(/Rescan failed: Token invalid/)).not.toBeNull();
		});
	});

	it("opens a modal containing the add repository form when Add Repository is clicked", () => {
		render(<RepoInventoryScreen {...defaultProps} />);

		fireEvent.click(screen.getByRole("button", { name: /add repository/i }));

		expect(screen.getByRole("dialog")).not.toBeNull();
		expect(screen.getByLabelText(/owner/i)).not.toBeNull();
		expect(screen.getByLabelText(/repository name/i)).not.toBeNull();
		expect(screen.getByRole("button", { name: /^add repository$/i })).not.toBeNull();
	});

	it("closes the modal when Cancel is clicked", () => {
		render(<RepoInventoryScreen {...defaultProps} />);

		fireEvent.click(screen.getByRole("button", { name: /add repository/i }));
		expect(screen.getByRole("dialog")).not.toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("closes the modal when Escape is pressed", () => {
		render(<RepoInventoryScreen {...defaultProps} />);

		fireEvent.click(screen.getByRole("button", { name: /add repository/i }));
		const dialog = screen.getByRole("dialog");
		expect(dialog).not.toBeNull();

		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("calls addRepo and refreshes the inventory on successful add, then closes the modal", async () => {
		mockedAddRepo.mockResolvedValue({ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", added: true });
		const onRescanComplete = vi.fn();
		render(<RepoInventoryScreen {...defaultProps} onRescanComplete={onRescanComplete} />);

		fireEvent.click(screen.getByRole("button", { name: /add repository/i }));
		fireEvent.change(screen.getByLabelText(/owner/i), { target: { value: "octocat" } });
		fireEvent.change(screen.getByLabelText(/repository name/i), { target: { value: "hello-world" } });
		fireEvent.click(screen.getByRole("button", { name: /^add repository$/i }));

		await waitFor(() => {
			expect(mockedAddRepo).toHaveBeenCalledWith("octocat", "hello-world");
		});
		await waitFor(() => {
			expect(onRescanComplete).toHaveBeenCalled();
		});
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});
	});

	it("displays a message in the modal when the repository is already configured", async () => {
		mockedAddRepo.mockResolvedValue({ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", added: false, message: "Repository already configured" });
		render(<RepoInventoryScreen {...defaultProps} />);

		fireEvent.click(screen.getByRole("button", { name: /add repository/i }));
		fireEvent.change(screen.getByLabelText(/owner/i), { target: { value: "octocat" } });
		fireEvent.change(screen.getByLabelText(/repository name/i), { target: { value: "hello-world" } });
		fireEvent.click(screen.getByRole("button", { name: /^add repository$/i }));

		await waitFor(() => {
			expect(screen.getByText(/repository already configured/i)).not.toBeNull();
		});
		expect(screen.getByRole("dialog")).not.toBeNull();
	});

	it("displays an inline error and keeps the modal open when addRepo fails", async () => {
		mockedAddRepo.mockRejectedValue(new Error("Repository not found or not accessible"));
		render(<RepoInventoryScreen {...defaultProps} />);

		fireEvent.click(screen.getByRole("button", { name: /add repository/i }));
		fireEvent.change(screen.getByLabelText(/owner/i), { target: { value: "unknown" } });
		fireEvent.change(screen.getByLabelText(/repository name/i), { target: { value: "missing" } });
		fireEvent.click(screen.getByRole("button", { name: /^add repository$/i }));

		await waitFor(() => {
			expect(screen.getByText(/Repository not found or not accessible/)).not.toBeNull();
		});
		expect(screen.getByRole("dialog")).not.toBeNull();
	});

	it("shows a validation error when owner or repo is missing", async () => {
		render(<RepoInventoryScreen {...defaultProps} />);

		fireEvent.click(screen.getByRole("button", { name: /add repository/i }));
		fireEvent.click(screen.getByRole("button", { name: /^add repository$/i }));

		await waitFor(() => {
			expect(screen.getByText(/owner and repository name are required/i)).not.toBeNull();
		});
		expect(mockedAddRepo).not.toHaveBeenCalled();
	});
});
