// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

import { OnboardingWizard } from "./OnboardingWizard.js";

function mockOkResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

vi.mock("../../api/onboarding.js", async () => {
	return {
		fetchOnboardingStatus: vi.fn(async () => ({ complete: false, missing: ["github_token"] })),
		verifyGitHubToken: vi.fn(async () => ({ username: "octocat" })),
		generateWebhookSecret: vi.fn(async () => ({ secret: "a".repeat(192) })),
		listAccessibleRepositories: vi.fn(async () => ({
			repositories: [
				{ owner: "mbrooks", repo: "tars", fullName: "mbrooks/tars" },
				{ owner: "octocat", repo: "hello", fullName: "octocat/hello" },
			],
		})),
		initializeWorkspaces: vi.fn(async () => ({ initialized: ["mbrooks/tars"] })),
		submitOnboarding: vi.fn(async () => ({ success: true, requiresRestart: ["github_token"] })),
	};
});

describe("OnboardingWizard", () => {
	let fetchSpy: any;

	beforeEach(() => {
		localStorage.clear();
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			return mockOkResponse({ success: true });
		});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		localStorage.clear();
	});

	it("renders step 1 by default", () => {
		render(<OnboardingWizard />);
		expect(screen.queryByText("Welcome to TARS")).not.toBeNull();
		expect(screen.queryByText("Step 1 of 4")).not.toBeNull();
		expect(screen.queryByLabelText("Admin Username")).not.toBeNull();
		expect(screen.queryByLabelText("Admin Password")).not.toBeNull();
	});

	it("suggests a password by default in plain text", () => {
		render(<OnboardingWizard />);
		const passwordInput = screen.getByLabelText("Admin Password") as HTMLInputElement;
		expect(passwordInput.value.length).toBeGreaterThan(0);
		expect(passwordInput.type).toBe("text");
	});

	it("regenerates password when regenerate button clicked", () => {
		render(<OnboardingWizard />);
		const passwordInput = screen.getByLabelText("Admin Password") as HTMLInputElement;
		const firstPassword = passwordInput.value;
		fireEvent.click(screen.getByText("Regenerate"));
		expect(passwordInput.value).not.toBe(firstPassword);
	});

	it("toggles password visibility via checkbox", () => {
		render(<OnboardingWizard />);
		const passwordInput = screen.getByLabelText("Admin Password") as HTMLInputElement;
		expect(passwordInput.type).toBe("text");
		const checkbox = screen.getByLabelText("Show password") as HTMLInputElement;
		expect(checkbox.checked).toBe(true);
		fireEvent.click(checkbox);
		expect(passwordInput.type).toBe("password");
		expect(checkbox.checked).toBe(false);
		fireEvent.click(checkbox);
		expect(passwordInput.type).toBe("text");
		expect(checkbox.checked).toBe(true);
	});

	it("navigates to step 2 after filling step 1", () => {
		render(<OnboardingWizard />);
		fireEvent.change(screen.getByLabelText("Admin Username"), { target: { value: "admin" } });
		fireEvent.click(screen.getByText("Next"));
		expect(screen.queryByText("Step 2 of 4")).not.toBeNull();
		expect(screen.queryByLabelText("GitHub PAT (Personal Access Token)")).not.toBeNull();
	});

	it("verifies token and infers username in step 2", async () => {
		const { verifyGitHubToken } = await import("../../api/onboarding.js");
		render(<OnboardingWizard />);
		fireEvent.change(screen.getByLabelText("Admin Username"), { target: { value: "admin" } });
		fireEvent.click(screen.getByText("Next"));

		fireEvent.change(screen.getByLabelText("GitHub PAT (Personal Access Token)"), { target: { value: "ghp_test" } });
		fireEvent.click(screen.getByText("Verify"));

		await waitFor(() => {
			expect(verifyGitHubToken).toHaveBeenCalledWith("ghp_test");
		});

		await waitFor(() => {
			expect(screen.queryByLabelText("GitHub Username")).not.toBeNull();
		});
	});

	it("navigates through all steps and submits", async () => {
		const { submitOnboarding, initializeWorkspaces } = await import("../../api/onboarding.js");
		render(<OnboardingWizard />);

		// Step 1
		fireEvent.change(screen.getByLabelText("Admin Username"), { target: { value: "admin" } });
		fireEvent.click(screen.getByText("Next"));

		// Step 2
		fireEvent.change(screen.getByLabelText("GitHub PAT (Personal Access Token)"), { target: { value: "ghp_test" } });
		fireEvent.click(screen.getByText("Verify"));
		await waitFor(() => expect(screen.queryByLabelText("GitHub Username")).not.toBeNull());
		fireEvent.click(screen.getByText("Next"));

		// Step 3
		fireEvent.click(screen.getByText("Generate"));
		await waitFor(() => expect(screen.queryByText("How to configure this secret in GitHub:")).not.toBeNull());

		fireEvent.click(screen.getByText("I have configured the webhook secret in my GitHub repository settings."));
		fireEvent.click(screen.getByText("Next"));

		// Step 4
		fireEvent.click(screen.getByText("Fetch Repositories"));
		await waitFor(() => expect(screen.queryByText("mbrooks/tars")).not.toBeNull());

		fireEvent.click(screen.getByText("Initialize & Finish"));
		await waitFor(() => expect(screen.queryByText("Setup Complete")).not.toBeNull());

		expect(submitOnboarding).toHaveBeenCalled();
		expect(initializeWorkspaces).toHaveBeenCalled();
	});

	it("preserves state in localStorage", () => {
		render(<OnboardingWizard />);
		fireEvent.change(screen.getByLabelText("Admin Username"), { target: { value: "admin" } });
		expect(localStorage.getItem("tars-onboarding-wizard")).toContain("admin");
	});

	it("restores state from localStorage", () => {
		localStorage.setItem(
			"tars-onboarding-wizard",
			JSON.stringify({
				step: 2,
				adminUsername: "stored-admin",
				adminPassword: "stored-pass",
				githubToken: "",
				githubUsername: "",
				githubUsernameConfirmed: false,
				webhookSecret: "",
				webhookSecretConfirmed: false,
				repositories: [],
				error: null,
			}),
		);
		render(<OnboardingWizard />);
		expect(screen.queryByText("Step 2 of 4")).not.toBeNull();
		expect(screen.queryByLabelText("Admin Username")).toBeNull();
	});

	it("allows going back to previous steps", () => {
		render(<OnboardingWizard />);
		fireEvent.change(screen.getByLabelText("Admin Username"), { target: { value: "admin" } });
		fireEvent.click(screen.getByText("Next"));
		expect(screen.queryByText("Step 2 of 4")).not.toBeNull();

		fireEvent.click(screen.getByText("Back"));
		expect(screen.queryByText("Step 1 of 4")).not.toBeNull();
	});

	it("disables next when step 1 fields are empty", () => {
		render(<OnboardingWizard />);
		const nextButton = screen.getByText("Next") as HTMLButtonElement;
		fireEvent.change(screen.getByLabelText("Admin Username"), { target: { value: "" } });
		expect(nextButton.disabled).toBe(true);
	});
});
