// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { RepoInventoryScreen } from "./RepoInventoryScreen.js";
import type { RepoSummary } from "../../app/types.js";

vi.mock("../../api/repos.js", () => ({
	scanRepos: vi.fn(),
}));

import { scanRepos } from "../../api/repos.js";

const mockedScanRepos = vi.mocked(scanRepos);

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
});
