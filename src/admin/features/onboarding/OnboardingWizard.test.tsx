// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

import { OnboardingWizard, buildInitialState } from "./OnboardingWizard.js";
import type { OnboardingConfig } from "../../api/onboarding.js";

function mockOkResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function emptyConfig(): OnboardingConfig {
	return {
		admin_username: "",
		admin_password: { configured: false },
		github_token: { configured: false },
		github_username: "",
		github_event_mode: "",
		github_poll_interval_ms: "",
		webhook_secret: { configured: false },
	};
}

vi.mock("../../api/onboarding.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../api/onboarding.js")>();
	return {
		...actual,
		fetchOnboardingConfig: vi.fn(async (): Promise<OnboardingConfig> => emptyConfig()),
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

/** Waits for the configuration-loading gate to finish and the form to render. */
async function waitForReady(): Promise<void> {
	await waitFor(() => {
		expect(screen.queryByText("Loading configuration…")).toBeNull();
	});
}

/** Advances the wizard from step 1 through step 2 (GitHub integration). */
async function advanceThroughGitHubIntegration(): Promise<void> {
	await waitForReady();
	await waitFor(() => expect(screen.queryByLabelText("Admin Username")).not.toBeNull());
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
		(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockImplementation(
			async (): Promise<OnboardingConfig> => emptyConfig(),
		);
		(onboarding.fetchOnboardingStatus as ReturnType<typeof vi.fn>).mockImplementation(
			async () => ({ complete: false, missing: ["github_token"], sources: {} }),
		);
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			return mockOkResponse({ success: true });
		});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		localStorage.clear();
	});

	describe("configuration pre-population", () => {
		it("shows a loading screen until configuration is loaded", async () => {
			let resolveConfig!: (value: OnboardingConfig) => void;
			const onboarding = await import("../../api/onboarding.js");
			(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockImplementation(
				() => new Promise<OnboardingConfig>((resolve) => { resolveConfig = resolve; }),
			);
			render(<OnboardingWizard />);
			expect(screen.queryByText("Loading configuration…")).not.toBeNull();
			expect(screen.queryByLabelText("Admin Username")).toBeNull();

			resolveConfig(emptyConfig());
			await waitFor(() => expect(screen.queryByText("Loading configuration…")).toBeNull());
			expect(screen.queryByLabelText("Admin Username")).not.toBeNull();
		});

		it("falls back to defaults when configuration loading fails", async () => {
			const onboarding = await import("../../api/onboarding.js");
			(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error("network down"),
			);
			render(<OnboardingWizard />);
			await waitForReady();
			expect(screen.queryByText(/Could not load current configuration/u)).not.toBeNull();
			expect(screen.queryByLabelText("Admin Username")).not.toBeNull();
			const passwordInput = screen.getByLabelText("Admin Password") as HTMLInputElement;
			expect(passwordInput.value.length).toBeGreaterThan(0);
		});

		it("pre-populates admin username from configuration", async () => {
			const onboarding = await import("../../api/onboarding.js");
			const config = emptyConfig();
			config.admin_username = "bob";
			(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockResolvedValue(config);
			render(<OnboardingWizard />);
			await waitForReady();
			expect((screen.getByLabelText("Admin Username") as HTMLInputElement).value).toBe("bob");
		});

		it("uses the default admin username when unset in configuration", async () => {
			render(<OnboardingWizard />);
			await waitForReady();
			expect((screen.getByLabelText("Admin Username") as HTMLInputElement).value).toBe("admin");
		});

		it("pre-populates github username and marks it confirmed from configuration", async () => {
			const onboarding = await import("../../api/onboarding.js");
			const config = emptyConfig();
			config.github_token = { configured: true };
			config.github_username = "configured-user";
			(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockResolvedValue(config);
			render(<OnboardingWizard />);
			await waitForReady();
			fireEvent.click(screen.getByText("Next"));
			// Username field is pre-populated without re-verifying the token.
			await waitFor(() => expect(screen.queryByLabelText("GitHub Username")).not.toBeNull());
			expect((screen.getByLabelText("GitHub Username") as HTMLInputElement).value).toBe("configured-user");
			expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(false);
		});

		it("pre-populates github event mode and polling interval for polling mode", async () => {
			const onboarding = await import("../../api/onboarding.js");
			const config = emptyConfig();
			config.github_event_mode = "polling";
			config.github_poll_interval_ms = "15000";
			(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockResolvedValue(config);
			render(<OnboardingWizard />);
			await advanceThroughGitHubIntegration();

			expect((screen.getByLabelText("GitHub Event Mode") as HTMLSelectElement).value).toBe("polling");
			expect((screen.getByLabelText("Polling Interval (ms)") as HTMLInputElement).value).toBe("15000");
			expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(false);
		});

		it("leaves the wizard defaults for partially configured values", async () => {
			const onboarding = await import("../../api/onboarding.js");
			const config = emptyConfig();
			config.admin_username = "alice";
			// github_event_mode and poll interval intentionally unset.
			(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockResolvedValue(config);
			render(<OnboardingWizard />);
			await advanceThroughGitHubIntegration();

			const select = screen.getByLabelText("GitHub Event Mode") as HTMLSelectElement;
			expect(select.value).toBe("");
			expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(true);
		});

		it("marks a configured admin password as protected and leaves the field blank", async () => {
			const onboarding = await import("../../api/onboarding.js");
			const config = emptyConfig();
			config.admin_password = { configured: true };
			(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockResolvedValue(config);
			render(<OnboardingWizard />);
			await waitForReady();
			const passwordInput = screen.getByLabelText("Admin Password") as HTMLInputElement;
			expect(passwordInput.value).toBe("");
			expect(passwordInput.placeholder).toContain("Leave unchanged");
			expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(false);
		});

		it("marks a configured github token as protected and allows proceeding without re-entering it", async () => {
			const onboarding = await import("../../api/onboarding.js");
			const config = emptyConfig();
			config.github_token = { configured: true };
			config.github_username = "configured-user";
			(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockResolvedValue(config);
			render(<OnboardingWizard />);
			await waitForReady();
			fireEvent.click(screen.getByText("Next"));
			await waitFor(() => expect(screen.queryByText("Step 2 of 4")).not.toBeNull());
			const tokenInput = screen.getByLabelText("GitHub PAT (Personal Access Token)") as HTMLInputElement;
			expect(tokenInput.value).toBe("");
			expect(tokenInput.placeholder).toContain("Leave unchanged");
			// Token is protected and username is pre-confirmed, so Next is enabled.
			expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(false);
		});

		it("marks a configured webhook secret as protected and does not auto-generate one", async () => {
			const onboarding = await import("../../api/onboarding.js");
			const config = emptyConfig();
			config.github_event_mode = "webhook";
			config.webhook_secret = { configured: true };
			(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockResolvedValue(config);
			render(<OnboardingWizard />);
			await advanceThroughGitHubIntegration();

			const secretInput = screen.getByLabelText("Webhook Secret") as HTMLInputElement;
			expect(secretInput.value).toBe("");
			expect(secretInput.placeholder).toContain("Leave unchanged");
			expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(false);
			expect(onboarding.generateWebhookSecret).not.toHaveBeenCalled();
		});

		it("unprotects the admin password when the operator types a new value", async () => {
			const onboarding = await import("../../api/onboarding.js");
			const config = emptyConfig();
			config.admin_password = { configured: true };
			(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockResolvedValue(config);
			render(<OnboardingWizard />);
			await waitForReady();
			const passwordInput = screen.getByLabelText("Admin Password") as HTMLInputElement;
			fireEvent.change(passwordInput, { target: { value: "newpass" } });
			expect(passwordInput.value).toBe("newpass");
			expect(passwordInput.placeholder).toBe("password");
		});

		it("unprotects the github token when the operator types a new value", async () => {
			const onboarding = await import("../../api/onboarding.js");
			const config = emptyConfig();
			config.github_token = { configured: true };
			config.github_username = "configured-user";
			(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockResolvedValue(config);
			render(<OnboardingWizard />);
			await waitForReady();
			fireEvent.click(screen.getByText("Next"));
			await waitFor(() => expect(screen.queryByText("Step 2 of 4")).not.toBeNull());
			const tokenInput = screen.getByLabelText("GitHub PAT (Personal Access Token)") as HTMLInputElement;
			fireEvent.change(tokenInput, { target: { value: "ghp_new" } });
			expect(tokenInput.value).toBe("ghp_new");
			expect(tokenInput.placeholder).toBe("ghp_...");
			// Typing a new token clears the pre-confirmed username.
			expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(true);
		});

		it("preserves a protected github token on submit without re-entering it", async () => {
			const onboarding = await import("../../api/onboarding.js");
			const config = emptyConfig();
			config.github_token = { configured: true };
			config.github_username = "configured-user";
			config.admin_password = { configured: true };
			config.github_event_mode = "webhook";
			config.webhook_secret = { configured: true };
			(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockResolvedValue(config);
			render(<OnboardingWizard />);
			await waitForReady();
			// Step 1: admin password protected, proceed.
			fireEvent.click(screen.getByText("Next"));
			// Step 2: token protected, username pre-confirmed, proceed.
			await waitFor(() => expect(screen.queryByText("Step 2 of 4")).not.toBeNull());
			fireEvent.click(screen.getByText("Next"));
			// Step 3: webhook mode with protected secret, proceed.
			await waitFor(() => expect(screen.queryByText("Step 3 of 4")).not.toBeNull());
			fireEvent.click(screen.getByText("Next"));
			// Step 4: finish (no repos selected; token is protected so init is skipped).
			await waitFor(() => expect(screen.queryByText("Step 4 of 4")).not.toBeNull());
			fireEvent.click(screen.getByText("Initialize & Finish"));
			await waitFor(() => expect(screen.queryByText("Setup Complete")).not.toBeNull());

			expect(onboarding.initializeWorkspaces).not.toHaveBeenCalled();
			expect(onboarding.submitOnboarding).toHaveBeenCalledTimes(1);
			const body = (onboarding.submitOnboarding as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, string>;
			// Protected secrets are submitted empty so the backend preserves them.
			expect(body.github_token).toBe("");
			expect(body.admin_password).toBe("");
			expect(body.webhook_secret).toBe("");
			expect(body.github_username).toBe("configured-user");
			expect(body.github_event_mode).toBe("webhook");
		});

		it("fetches repositories and initializes workspaces using the stored token when it is protected", async () => {
			const onboarding = await import("../../api/onboarding.js");
			const config = emptyConfig();
			config.github_token = { configured: true };
			config.github_username = "configured-user";
			config.admin_password = { configured: true };
			config.github_event_mode = "webhook";
			config.webhook_secret = { configured: true };
			(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockResolvedValue(config);
			render(<OnboardingWizard />);
			await waitForReady();
			// Step 1: admin password protected, proceed.
			fireEvent.click(screen.getByText("Next"));
			// Step 2: token protected, username pre-confirmed, proceed.
			await waitFor(() => expect(screen.queryByText("Step 2 of 4")).not.toBeNull());
			fireEvent.click(screen.getByText("Next"));
			// Step 3: webhook mode with protected secret, proceed.
			await waitFor(() => expect(screen.queryByText("Step 3 of 4")).not.toBeNull());
			fireEvent.click(screen.getByText("Next"));
			// Step 4: token is protected, so the Fetch button is enabled and the
			// backend resolves the stored token from the empty submitted value.
			await waitFor(() => expect(screen.queryByText("Step 4 of 4")).not.toBeNull());
			expect(screen.queryByText("Using the configured GitHub token.")).not.toBeNull();
			fireEvent.click(screen.getByText("Fetch Repositories"));
			await waitFor(() => expect(screen.queryByText("mbrooks/tars")).not.toBeNull());

			fireEvent.click(screen.getByText("Initialize & Finish"));
			await waitFor(() => expect(screen.queryByText("Setup Complete")).not.toBeNull());

			expect(onboarding.listAccessibleRepositories).toHaveBeenCalledWith("");
			expect(onboarding.initializeWorkspaces).toHaveBeenCalledWith({
				token: "",
				username: "configured-user",
				repos: [{ owner: "mbrooks", repo: "tars" }, { owner: "octocat", repo: "hello" }],
			});
			expect(onboarding.submitOnboarding).toHaveBeenCalledTimes(1);
		});

		it("rerunning onboarding shows the values currently configured in the app", async () => {
			const onboarding = await import("../../api/onboarding.js");
			const config = emptyConfig();
			config.admin_username = "existing-admin";
			config.github_username = "existing-user";
			config.github_event_mode = "polling";
			config.github_poll_interval_ms = "30000";
			config.github_token = { configured: true };
			config.admin_password = { configured: true };
			(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockResolvedValue(config);
			render(<OnboardingWizard />);
			await waitForReady();
			expect((screen.getByLabelText("Admin Username") as HTMLInputElement).value).toBe("existing-admin");
			const passwordInput = screen.getByLabelText("Admin Password") as HTMLInputElement;
			expect(passwordInput.value).toBe("");
			expect(passwordInput.placeholder).toContain("Leave unchanged");
		});
	});

	describe("buildInitialState", () => {
		it("returns defaults when no config is provided", () => {
			const state = buildInitialState(null);
			expect(state.step).toBe(1);
			expect(state.adminUsername).toBe("admin");
			expect(state.adminPasswordProtected).toBe(false);
			expect(state.githubTokenProtected).toBe(false);
			expect(state.webhookSecretProtected).toBe(false);
			expect(state.githubUsernameConfirmed).toBe(false);
			expect(state.githubEventMode).toBe("");
		});

		it("preserves in-progress localStorage state over config for edited fields", () => {
			localStorage.setItem(
				"tars-onboarding-wizard",
				JSON.stringify({
					step: 2,
					adminUsername: "in-progress-admin",
					adminPassword: "typed-pass",
					adminPasswordProtected: false,
					githubToken: "ghp_typed",
					githubTokenProtected: false,
					githubUsername: "typed-user",
					githubUsernameConfirmed: true,
					githubEventMode: "polling",
					githubPollIntervalMs: "20000",
					webhookSecret: "",
					webhookSecretProtected: false,
					repositories: [],
					error: null,
				}),
			);
			const config: OnboardingConfig = {
				admin_username: "configured-admin",
				admin_password: { configured: true },
				github_token: { configured: true },
				github_username: "configured-user",
				github_event_mode: "webhook",
				github_poll_interval_ms: "15000",
				webhook_secret: { configured: true },
			};
			const state = buildInitialState(config);
			expect(state.step).toBe(2);
			expect(state.adminUsername).toBe("in-progress-admin");
			expect(state.adminPassword).toBe("typed-pass");
			expect(state.adminPasswordProtected).toBe(false);
			expect(state.githubToken).toBe("ghp_typed");
			expect(state.githubTokenProtected).toBe(false);
			expect(state.githubEventMode).toBe("polling");
			expect(state.githubPollIntervalMs).toBe("20000");
		});

		it("unprotects sensitive fields when localStorage has a replacement value", () => {
			localStorage.setItem(
				"tars-onboarding-wizard",
				JSON.stringify({
					step: 1,
					adminUsername: "admin",
					adminPassword: "new-pass",
					adminPasswordProtected: true,
					githubToken: "ghp_replacement",
					githubTokenProtected: true,
					githubUsername: "",
					githubUsernameConfirmed: false,
					githubEventMode: "",
					githubPollIntervalMs: "",
					webhookSecret: "new-secret",
					webhookSecretProtected: true,
					repositories: [],
					error: null,
				}),
			);
			const config: OnboardingConfig = {
				admin_username: "admin",
				admin_password: { configured: true },
				github_token: { configured: true },
				github_username: "",
				github_event_mode: "",
				github_poll_interval_ms: "",
				webhook_secret: { configured: true },
			};
			const state = buildInitialState(config);
			expect(state.adminPasswordProtected).toBe(false);
			expect(state.githubTokenProtected).toBe(false);
			expect(state.webhookSecretProtected).toBe(false);
		});
	});

	describe("env-sourced fields", () => {
		it("buildInitialState records env-sourced fields from sources", () => {
			const state = buildInitialState(emptyConfig(), {
				github_token: "env",
				admin_password: "env",
				webhook_secret: "env",
			});
			expect(state.envSourced.github_token).toBe(true);
			expect(state.envSourced.admin_password).toBe(true);
			expect(state.envSourced.webhook_secret).toBe(true);
			expect(state.envSourced.admin_username).toBe(false);
		});

		it("shows a banner when any required field is env-sourced", async () => {
			const onboarding = await import("../../api/onboarding.js");
			(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockResolvedValue(emptyConfig());
			(onboarding.fetchOnboardingStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
				complete: false,
				missing: [],
				sources: { admin_password: "env" },
			});
			render(<OnboardingWizard />);
			await waitForReady();
			expect(screen.getByText(/Some settings are locked/u)).not.toBeNull();
		});

		it("does not show the banner when no fields are env-sourced", async () => {
			const onboarding = await import("../../api/onboarding.js");
			(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockResolvedValue(emptyConfig());
			(onboarding.fetchOnboardingStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
				complete: false,
				missing: [],
				sources: {},
			});
			render(<OnboardingWizard />);
			await waitForReady();
			expect(screen.queryByText(/Some settings are locked/u)).toBeNull();
		});

		it("disables env-sourced admin credentials inputs and still allows proceeding", async () => {
			const onboarding = await import("../../api/onboarding.js");
			const config = emptyConfig();
			config.admin_username = "env-admin";
			config.admin_password = { configured: true };
			(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockResolvedValue(config);
			(onboarding.fetchOnboardingStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
				complete: false,
				missing: [],
				sources: { admin_username: "env", admin_password: "env" },
			});
			const { container } = render(<OnboardingWizard />);
			await waitForReady();
			const usernameInput = screen.getByLabelText("Admin Username") as HTMLInputElement;
			const passwordInput = screen.getByLabelText("Admin Password") as HTMLInputElement;
			expect(usernameInput.disabled).toBe(true);
			expect(passwordInput.disabled).toBe(true);
			const warnings = container.querySelectorAll(".env-source-warning");
			expect(Array.from(warnings).some((el) => el.textContent?.includes("ADMIN_USERNAME"))).toBe(true);
			// Env-sourced fields satisfy the step, so Next is enabled.
			expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(false);
		});

		it("completes onboarding when all required fields are env-sourced", async () => {
			const onboarding = await import("../../api/onboarding.js");
			const config = emptyConfig();
			config.admin_username = "env-admin";
			config.admin_password = { configured: true };
			config.github_token = { configured: true };
			config.github_username = "env-user";
			config.github_event_mode = "webhook";
			config.webhook_secret = { configured: true };
			(onboarding.fetchOnboardingConfig as ReturnType<typeof vi.fn>).mockResolvedValue(config);
			(onboarding.fetchOnboardingStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
				complete: false,
				missing: [],
				sources: {
					admin_username: "env",
					admin_password: "env",
					github_token: "env",
					github_username: "env",
					github_event_mode: "env",
					webhook_secret: "env",
				},
			});
			render(<OnboardingWizard />);
			await waitForReady();
			// Step 1
			expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(false);
			fireEvent.click(screen.getByText("Next"));
			// Step 2
			await waitFor(() => expect(screen.queryByText("Step 2 of 4")).not.toBeNull());
			const tokenInput = screen.getByLabelText("GitHub PAT (Personal Access Token)") as HTMLInputElement;
			expect(tokenInput.disabled).toBe(true);
			expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(false);
			fireEvent.click(screen.getByText("Next"));
			// Step 3
			await waitFor(() => expect(screen.queryByText("Step 3 of 4")).not.toBeNull());
			expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(false);
			fireEvent.click(screen.getByText("Next"));
			// Step 4
			await waitFor(() => expect(screen.queryByText("Step 4 of 4")).not.toBeNull());
			fireEvent.click(screen.getByText("Initialize & Finish"));
			await waitFor(() => expect(screen.queryByText("Setup Complete")).not.toBeNull());

			expect(onboarding.submitOnboarding).toHaveBeenCalledTimes(1);
			const body = (onboarding.submitOnboarding as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, string>;
			// Env-sourced keys are omitted from the submission body.
			expect(body.github_token).toBeUndefined();
			expect(body.admin_password).toBeUndefined();
			expect(body.webhook_secret).toBeUndefined();
			expect(body.github_event_mode).toBeUndefined();
			expect(body.admin_username).toBeUndefined();
			expect(body.github_username).toBeUndefined();
		});
	});

	it("renders step 1 by default", async () => {
		render(<OnboardingWizard />);
		await waitForReady();
		expect(screen.queryByText("Welcome to TARS")).not.toBeNull();
		expect(screen.queryByText("Step 1 of 4")).not.toBeNull();
		expect(screen.queryByLabelText("Admin Username")).not.toBeNull();
		expect(screen.queryByLabelText("Admin Password")).not.toBeNull();
	});

	it("suggests a password by default in plain text", async () => {
		render(<OnboardingWizard />);
		await waitForReady();
		const passwordInput = screen.getByLabelText("Admin Password") as HTMLInputElement;
		expect(passwordInput.value.length).toBeGreaterThan(0);
		expect(passwordInput.type).toBe("text");
	});

	it("regenerates password when regenerate button clicked", async () => {
		render(<OnboardingWizard />);
		await waitForReady();
		const passwordInput = screen.getByLabelText("Admin Password") as HTMLInputElement;
		const firstPassword = passwordInput.value;
		fireEvent.click(screen.getByText("Regenerate"));
		expect(passwordInput.value).not.toBe(firstPassword);
	});

	it("toggles password visibility via checkbox", async () => {
		render(<OnboardingWizard />);
		await waitForReady();
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

	it("navigates to step 2 after filling step 1", async () => {
		render(<OnboardingWizard />);
		await waitForReady();
		fireEvent.change(screen.getByLabelText("Admin Username"), { target: { value: "admin" } });
		fireEvent.click(screen.getByText("Next"));
		expect(screen.queryByText("Step 2 of 4")).not.toBeNull();
		expect(screen.queryByLabelText("GitHub PAT (Personal Access Token)")).not.toBeNull();
	});

	it("verifies token and infers username in step 2", async () => {
		const { verifyGitHubToken } = await import("../../api/onboarding.js");
		render(<OnboardingWizard />);
		await waitForReady();
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
		await waitForReady();

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
		await waitForReady();
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

	it("preserves state in localStorage", async () => {
		render(<OnboardingWizard />);
		await waitForReady();
		fireEvent.change(screen.getByLabelText("Admin Username"), { target: { value: "admin" } });
		await waitFor(() => expect(localStorage.getItem("tars-onboarding-wizard")).toContain("admin"));
	});

	it("restores state from localStorage", async () => {
		localStorage.setItem(
			"tars-onboarding-wizard",
			JSON.stringify({
				step: 2,
				adminUsername: "stored-admin",
				adminPassword: "stored-pass",
				adminPasswordProtected: false,
				githubToken: "",
				githubTokenProtected: false,
				githubUsername: "",
				githubUsernameConfirmed: false,
				githubEventMode: "",
				githubPollIntervalMs: "",
				webhookSecret: "",
				webhookSecretProtected: false,
				repositories: [],
				error: null,
			}),
		);
		render(<OnboardingWizard />);
		await waitForReady();
		expect(screen.queryByText("Step 2 of 4")).not.toBeNull();
		expect(screen.queryByLabelText("Admin Username")).toBeNull();
	});

	it("allows going back to previous steps", async () => {
		render(<OnboardingWizard />);
		await waitForReady();
		fireEvent.change(screen.getByLabelText("Admin Username"), { target: { value: "admin" } });
		fireEvent.click(screen.getByText("Next"));
		expect(screen.queryByText("Step 2 of 4")).not.toBeNull();

		fireEvent.click(screen.getByText("Back"));
		expect(screen.queryByText("Step 1 of 4")).not.toBeNull();
	});

	it("disables next when step 1 fields are empty", async () => {
		render(<OnboardingWizard />);
		await waitForReady();
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

	it("deselects and selects all repositories in step 4", async () => {
		localStorage.setItem(
			"tars-onboarding-wizard",
			JSON.stringify({
				step: 4,
				adminUsername: "admin",
				adminPassword: "password",
				adminPasswordProtected: false,
				githubToken: "ghp_test",
				githubTokenProtected: false,
				githubUsername: "octocat",
				githubUsernameConfirmed: true,
				githubEventMode: "webhook",
				githubPollIntervalMs: "",
				webhookSecret: "webhook-secret",
				webhookSecretProtected: false,
				repositories: [
					{ owner: "mbrooks", repo: "tars", fullName: "mbrooks/tars", selected: true },
					{ owner: "octocat", repo: "hello", fullName: "octocat/hello", selected: true },
				],
				error: null,
			}),
		);
		render(<OnboardingWizard />);
		await waitForReady();
		await waitFor(() => expect(screen.queryByText("Step 4 of 4")).not.toBeNull());

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