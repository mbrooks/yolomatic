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
		submitOnboarding: vi.fn(async () => ({ success: true, activated: true, requiresRestart: [] })),
	};
});

/** Advances the wizard from step 1 through step 2 (GitHub integration). */
async function advanceThroughGitHubIntegration(): Promise<void> {
	fireEvent.change(screen.getByLabelText("Admin Username"), { target: { value: "admin" } });
	fireEvent.click(screen.getByText("Next"));
	fireEvent.change(screen.getByLabelText("GitHub PAT (Personal Access Token)"), { target: { value: "ghp_test" } });
	fireEvent.click(screen.getByText("Verify"));
	await waitFor(() => expect(screen.queryByLabelText("GitHub Username")).not.toBeNull());
	fireEvent.click(screen.getByText("Next"));
}

describe("OnboardingWizard", () => {
	let fetchSpy: any;

	beforeEach(async () => {
		localStorage.clear();
		const onboarding = await import("../../api/onboarding.js");
		Object.values(onboarding).forEach((fn) => {
			if (typeof fn === "function" && "mockClear" in fn) {
				(fn as ReturnType<typeof vi.fn>).mockClear();
			}
		});
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

	describe("step 3 - GitHub event mode", () => {
		it("offers webhook, polling, and both options", async () => {
			render(<OnboardingWizard />);
			await advanceThroughGitHubIntegration();

			expect(screen.queryByText("Step 3 of 4")).not.toBeNull();
			const select = screen.getByLabelText("GitHub Event Mode") as HTMLSelectElement;
			const optionValues = Array.from(select.options).map((o) => o.value);
			expect(optionValues).toEqual(["", "webhook", "polling", "both"]);
		});

		it("disables Next until an event mode is selected", async () => {
			render(<OnboardingWizard />);
			await advanceThroughGitHubIntegration();

			const nextButton = screen.getByText("Next") as HTMLButtonElement;
			expect(nextButton.disabled).toBe(true);
		});

		it("does not show or require a polling interval for webhook mode", async () => {
			render(<OnboardingWizard />);
			await advanceThroughGitHubIntegration();

			fireEvent.change(screen.getByLabelText("GitHub Event Mode"), { target: { value: "webhook" } });
			expect(screen.queryByLabelText("Polling Interval (ms)")).toBeNull();
		});

		it("shows and requires a polling interval for polling mode", async () => {
			render(<OnboardingWizard />);
			await advanceThroughGitHubIntegration();

			fireEvent.change(screen.getByLabelText("GitHub Event Mode"), { target: { value: "polling" } });
			expect(screen.queryByLabelText("Polling Interval (ms)")).not.toBeNull();
		});

		it("does not show a webhook secret for polling-only mode", async () => {
			render(<OnboardingWizard />);
			await advanceThroughGitHubIntegration();

			fireEvent.change(screen.getByLabelText("GitHub Event Mode"), { target: { value: "polling" } });
			expect(screen.queryByLabelText("Webhook Secret")).toBeNull();
			expect(screen.queryByText(/No webhook secret is required for polling-only mode/u)).not.toBeNull();
		});

		it("shows a webhook secret input for webhook mode", async () => {
			render(<OnboardingWizard />);
			await advanceThroughGitHubIntegration();

			fireEvent.change(screen.getByLabelText("GitHub Event Mode"), { target: { value: "webhook" } });
			expect(screen.queryByLabelText("Webhook Secret")).not.toBeNull();
		});

		it("shows a webhook secret input for both mode", async () => {
			render(<OnboardingWizard />);
			await advanceThroughGitHubIntegration();

			fireEvent.change(screen.getByLabelText("GitHub Event Mode"), { target: { value: "both" } });
			expect(screen.queryByLabelText("Webhook Secret")).not.toBeNull();
			expect(screen.queryByLabelText("Polling Interval (ms)")).not.toBeNull();
		});

		it("auto-generates a webhook secret for webhook mode", async () => {
			render(<OnboardingWizard />);
			await advanceThroughGitHubIntegration();

			fireEvent.change(screen.getByLabelText("GitHub Event Mode"), { target: { value: "webhook" } });
			await waitFor(() => {
				expect((screen.getByLabelText("Webhook Secret") as HTMLInputElement).value.length).toBeGreaterThan(0);
			});
		});

		it("disables Next when the webhook secret is empty for webhook mode", async () => {
			render(<OnboardingWizard />);
			await advanceThroughGitHubIntegration();

			fireEvent.change(screen.getByLabelText("GitHub Event Mode"), { target: { value: "webhook" } });
			await waitFor(() => {
				expect((screen.getByLabelText("Webhook Secret") as HTMLInputElement).value.length).toBeGreaterThan(0);
			});
			fireEvent.change(screen.getByLabelText("Webhook Secret"), { target: { value: "" } });
			expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(true);
		});

		it("hides the GitHub configuration instructions behind a button until clicked", async () => {
			render(<OnboardingWizard />);
			await advanceThroughGitHubIntegration();

			fireEvent.change(screen.getByLabelText("GitHub Event Mode"), { target: { value: "webhook" } });
			await waitFor(() => {
				expect((screen.getByLabelText("Webhook Secret") as HTMLInputElement).value.length).toBeGreaterThan(0);
			});

			// Instructions are not rendered inline on the step.
			expect(screen.queryByText("How to configure this secret in GitHub:")).toBeNull();
			const trigger = screen.getByRole("button", { name: /How do I configure this secret in GitHub\?/u });
			fireEvent.click(trigger);
			expect(screen.queryByText("Configure the webhook secret in GitHub")).not.toBeNull();
			const dialog = screen.getByRole("dialog");
			expect(dialog.textContent).toContain("Payload URL");
		});

		it("prefills the default polling interval when a polling mode is first selected", async () => {
			render(<OnboardingWizard />);
			await advanceThroughGitHubIntegration();

			fireEvent.change(screen.getByLabelText("GitHub Event Mode"), { target: { value: "polling" } });
			const intervalInput = screen.getByLabelText("Polling Interval (ms)") as HTMLInputElement;
			expect(intervalInput.value).toBe("60000");
			expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(false);
		});

		it("disables Next when the polling interval is below the minimum", async () => {
			render(<OnboardingWizard />);
			await advanceThroughGitHubIntegration();

			fireEvent.change(screen.getByLabelText("GitHub Event Mode"), { target: { value: "polling" } });
			fireEvent.change(screen.getByLabelText("Polling Interval (ms)"), { target: { value: "999" } });
			expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(true);
		});

		it("disables Next when the polling interval is not a whole number", async () => {
			render(<OnboardingWizard />);
			await advanceThroughGitHubIntegration();

			fireEvent.change(screen.getByLabelText("GitHub Event Mode"), { target: { value: "both" } });
			fireEvent.change(screen.getByLabelText("Polling Interval (ms)"), { target: { value: "abc" } });
			expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(true);
		});

		it("hides the polling interval when switching back to webhook mode", async () => {
			render(<OnboardingWizard />);
			await advanceThroughGitHubIntegration();

			fireEvent.change(screen.getByLabelText("GitHub Event Mode"), { target: { value: "polling" } });
			expect(screen.queryByLabelText("Polling Interval (ms)")).not.toBeNull();
			fireEvent.change(screen.getByLabelText("GitHub Event Mode"), { target: { value: "webhook" } });
			expect(screen.queryByLabelText("Polling Interval (ms)")).toBeNull();
		});

		it("indicates that the event mode is a default setting overridable per project", async () => {
			render(<OnboardingWizard />);
			await advanceThroughGitHubIntegration();

			expect(screen.queryByText(/These are the default settings for all projects/u)).not.toBeNull();
			expect(screen.queryByText(/Each project can override them later/u)).not.toBeNull();
		});
	});

	it("navigates through all steps and submits with webhook event mode", async () => {
		const { submitOnboarding, initializeWorkspaces } = await import("../../api/onboarding.js");
		const onComplete = vi.fn();
		render(<OnboardingWizard onComplete={onComplete} />);

		fireEvent.change(screen.getByLabelText("Admin Username"), { target: { value: "admin" } });
		fireEvent.click(screen.getByText("Next"));

		fireEvent.change(screen.getByLabelText("GitHub PAT (Personal Access Token)"), { target: { value: "ghp_test" } });
		fireEvent.click(screen.getByText("Verify"));
		await waitFor(() => expect(screen.queryByLabelText("GitHub Username")).not.toBeNull());
		fireEvent.click(screen.getByText("Next"));

		expect(screen.queryByText("Step 3 of 4")).not.toBeNull();
		fireEvent.change(screen.getByLabelText("GitHub Event Mode"), { target: { value: "webhook" } });
		await waitFor(() => {
			expect((screen.getByLabelText("Webhook Secret") as HTMLInputElement).value.length).toBeGreaterThan(0);
		});
		fireEvent.click(screen.getByText("Next"));

		expect(screen.queryByText("Step 4 of 4")).not.toBeNull();
		fireEvent.click(screen.getByText("Fetch Repositories"));
		await waitFor(() => expect(screen.queryByText("mbrooks/tars")).not.toBeNull());

		fireEvent.click(screen.getByText("Initialize & Finish"));
		await waitFor(() => expect(screen.queryByText("Setup Complete")).not.toBeNull());

		expect(screen.queryByText("Your settings have been saved and TARS is loading them now.")).not.toBeNull();
		expect(screen.queryByText(/Restart TARS/u)).toBeNull();
		expect(onComplete).toHaveBeenCalledTimes(1);
		expect(initializeWorkspaces).toHaveBeenCalled();
		expect(submitOnboarding).toHaveBeenCalled();
		const body = (submitOnboarding as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, string>;
		expect(body.github_event_mode).toBe("webhook");
		expect(body.webhook_secret).toBeDefined();
		expect(body.github_poll_interval_ms).toBeUndefined();
	});

	it("submits a polling interval and omits a webhook secret for polling mode", async () => {
		const { submitOnboarding } = await import("../../api/onboarding.js");
		render(<OnboardingWizard />);

		fireEvent.change(screen.getByLabelText("Admin Username"), { target: { value: "admin" } });
		fireEvent.click(screen.getByText("Next"));
		fireEvent.change(screen.getByLabelText("GitHub PAT (Personal Access Token)"), { target: { value: "ghp_test" } });
		fireEvent.click(screen.getByText("Verify"));
		await waitFor(() => expect(screen.queryByLabelText("GitHub Username")).not.toBeNull());
		fireEvent.click(screen.getByText("Next"));

		fireEvent.change(screen.getByLabelText("GitHub Event Mode"), { target: { value: "polling" } });
		fireEvent.change(screen.getByLabelText("Polling Interval (ms)"), { target: { value: "15000" } });
		fireEvent.click(screen.getByText("Next"));

		expect(screen.queryByText("Step 4 of 4")).not.toBeNull();
		fireEvent.click(screen.getByText("Fetch Repositories"));
		await waitFor(() => expect(screen.queryByText("mbrooks/tars")).not.toBeNull());

		fireEvent.click(screen.getByText("Initialize & Finish"));
		await waitFor(() => expect(screen.queryByText("Setup Complete")).not.toBeNull());

		const body = (submitOnboarding as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, string>;
		expect(body.github_event_mode).toBe("polling");
		expect(body.github_poll_interval_ms).toBe("15000");
		expect(body.webhook_secret).toBeUndefined();
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
				githubEventMode: "",
				githubPollIntervalMs: "",
				webhookSecret: "",
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

	it("toggles webhook secret visibility in step 3 for webhook mode", async () => {
		render(<OnboardingWizard />);
		await advanceThroughGitHubIntegration();

		fireEvent.change(screen.getByLabelText("GitHub Event Mode"), { target: { value: "webhook" } });
		await waitFor(() => {
			expect((screen.getByLabelText("Webhook Secret") as HTMLInputElement).value.length).toBeGreaterThan(0);
		});
		const secretInput = screen.getByLabelText("Webhook Secret") as HTMLInputElement;
		expect(secretInput.type).toBe("text");

		const showCheckbox = screen.getByLabelText("Show secret") as HTMLInputElement;
		expect(showCheckbox.checked).toBe(true);
		fireEvent.click(showCheckbox);
		expect(secretInput.type).toBe("password");
		expect(showCheckbox.checked).toBe(false);
		fireEvent.click(showCheckbox);
		expect(secretInput.type).toBe("text");
		expect(showCheckbox.checked).toBe(true);
	});

	it("allows manually configuring a shorter webhook secret and proceeding to step 4", async () => {
		render(<OnboardingWizard />);
		await advanceThroughGitHubIntegration();

		fireEvent.change(screen.getByLabelText("GitHub Event Mode"), { target: { value: "webhook" } });
		await waitFor(() => {
			expect((screen.getByLabelText("Webhook Secret") as HTMLInputElement).value.length).toBeGreaterThan(0);
		});
		const secretInput = screen.getByLabelText("Webhook Secret") as HTMLInputElement;

		fireEvent.change(secretInput, { target: { value: "" } });
		const manualSecret = "changed-webhook-api-key";
		fireEvent.change(secretInput, { target: { value: manualSecret } });

		expect((screen.getByLabelText("Webhook Secret") as HTMLInputElement).value).toBe(manualSecret);

		fireEvent.click(screen.getByText("Next"));
		expect(screen.queryByText("Step 4 of 4")).not.toBeNull();
	});

	it("deselects and selects all repositories in step 4", () => {
		localStorage.setItem(
			"tars-onboarding-wizard",
			JSON.stringify({
				step: 4,
				adminUsername: "admin",
				adminPassword: "password",
				githubToken: "ghp_test",
				githubUsername: "octocat",
				githubUsernameConfirmed: true,
				githubEventMode: "webhook",
				githubPollIntervalMs: "",
				webhookSecret: "webhook-secret",
				repositories: [
					{ owner: "mbrooks", repo: "tars", fullName: "mbrooks/tars", selected: true },
					{ owner: "octocat", repo: "hello", fullName: "octocat/hello", selected: true },
				],
				error: null,
			}),
		);
		render(<OnboardingWizard />);

		const repositoryCheckboxes = [
			screen.getByLabelText("mbrooks/tars") as HTMLInputElement,
			screen.getByLabelText("octocat/hello") as HTMLInputElement,
		];
		expect(repositoryCheckboxes.every((checkbox) => checkbox.checked)).toBe(true);

		fireEvent.click(screen.getByRole("button", { name: "Deselect All" }));
		expect(repositoryCheckboxes.every((checkbox) => !checkbox.checked)).toBe(true);

		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		expect(repositoryCheckboxes.every((checkbox) => checkbox.checked)).toBe(true);
	});
});