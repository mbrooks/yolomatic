// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { RepoInventoryScreen } from "./RepoInventoryScreen.js";
import type { RepoSummary } from "../../app/types.js";

vi.mock("../../api/repos.js", () => ({
	addRepo: vi.fn(),
}));

import { addRepo } from "../../api/repos.js";

const mockedAddRepo = vi.mocked(addRepo);

function makeRepo(overrides: Partial<RepoSummary> = {}): RepoSummary {
	return {
		owner: "mbrooks",
		repo: "yeetomatic",
		sessionCount: 1,
		activeCount: 0,
		implementationSessionCount: 1,
		implementationActiveCount: 0,
		refinementSessionCount: 0,
		refinementActiveCount: 0,
		lastActivity: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

const defaultProps = {
	repos: [] as RepoSummary[],
	onSelectRepo: vi.fn(),
	onBack: vi.fn(),
	onMutate: vi.fn(),
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("RepoInventoryScreen", () => {
	it("does not render a Rescan button", () => {
		render(<RepoInventoryScreen {...defaultProps} />);
		expect(screen.queryByRole("button", { name: /rescan/i })).toBeNull();
	});

	it("renders empty state when no repos", () => {
		render(<RepoInventoryScreen {...defaultProps} />);
		expect(screen.getByText("No repositories have been used yet.")).not.toBeNull();
	});

	it("renders repo rows", () => {
		const repos = [
			makeRepo({ owner: "mbrooks", repo: "yeetomatic", sessionCount: 2 }),
			makeRepo({ owner: "octocat", repo: "hello-world", sessionCount: 0 }),
		];
		render(<RepoInventoryScreen {...defaultProps} repos={repos} />);

		expect(screen.getByText("mbrooks/yeetomatic")).not.toBeNull();
		expect(screen.getByText("octocat/hello-world")).not.toBeNull();
	});

	it("shows implementation and refinement activity separately", () => {
		render(
			<RepoInventoryScreen
				{...defaultProps}
				repos={[makeRepo({
					sessionCount: 3,
					activeCount: 2,
					implementationSessionCount: 2,
					implementationActiveCount: 1,
					refinementSessionCount: 1,
					refinementActiveCount: 1,
				})]}
			/>,
		);
		expect(screen.getByText("1 active / 2 total")).not.toBeNull();
		expect(screen.getByText("1 active / 1 total")).not.toBeNull();
	});

	it("calls onSelectRepo when a row is clicked", () => {
		const onSelectRepo = vi.fn();
		const repos = [makeRepo()];
		render(<RepoInventoryScreen {...defaultProps} repos={repos} onSelectRepo={onSelectRepo} />);

		fireEvent.click(screen.getByText("mbrooks/yeetomatic"));
		expect(onSelectRepo).toHaveBeenCalledWith("mbrooks", "yeetomatic");
	});

	it("opens a modal containing the add repository form when Add Repository is clicked", () => {
		render(<RepoInventoryScreen {...defaultProps} />);

		fireEvent.click(screen.getByRole("button", { name: /add repository/i }));

		expect(screen.getByRole("dialog")).not.toBeNull();
		expect(screen.getByLabelText(/owner/i)).not.toBeNull();
		expect(screen.getByLabelText(/repository name/i)).not.toBeNull();
		expect(screen.getByRole("button", { name: /^add repository$/i })).not.toBeNull();
	});

	it("wraps each input inside its label so the add-repository styles apply", () => {
		render(<RepoInventoryScreen {...defaultProps} />);

		fireEvent.click(screen.getByRole("button", { name: /add repository/i }));

		const ownerLabel = screen.getByText("Owner").closest("label");
		const repoLabel = screen.getByText("Repository name").closest("label");
		expect(ownerLabel?.querySelector("input#repo-add-owner")).not.toBeNull();
		expect(repoLabel?.querySelector("input#repo-add-repo")).not.toBeNull();
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
		const onMutate = vi.fn();
		render(<RepoInventoryScreen {...defaultProps} onMutate={onMutate} />);

		fireEvent.click(screen.getByRole("button", { name: /add repository/i }));
		fireEvent.change(screen.getByLabelText(/owner/i), { target: { value: "octocat" } });
		fireEvent.change(screen.getByLabelText(/repository name/i), { target: { value: "hello-world" } });
		fireEvent.click(screen.getByRole("button", { name: /^add repository$/i }));

		await waitFor(() => {
			expect(mockedAddRepo).toHaveBeenCalledWith("octocat", "hello-world");
		});
		await waitFor(() => {
			expect(onMutate).toHaveBeenCalled();
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
