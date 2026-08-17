import { describe, expect, it } from "vitest";

import { buildOnboardingBody } from "./wizard-submission.js";
import { getDefaultState, type WizardState } from "./wizard-state.js";

function baseState(overrides: Partial<WizardState> = {}): WizardState {
	return { ...getDefaultState(), ...overrides } as WizardState;
}

describe("buildOnboardingBody", () => {
	it("includes the admin, github, and AI/LLM fields for webhook mode", () => {
		const body = buildOnboardingBody(
			baseState({
				adminFullName: "Admin User",
				adminUsername: "admin",
				adminPassword: "pass",
				githubToken: "ghp_test",
				githubUsername: "octocat",
				githubEventMode: "webhook",
				webhookSecret: "secret",
				piAgentProvider: "ollama",
				piAgentModel: "kimi",
				ollamaContainerName: "yolomatic-ollama",
			}),
		);
		expect(body).toEqual({
			github_token: "ghp_test",
			github_username: "octocat",
			admin_full_name: "Admin User",
			admin_username: "admin",
			admin_password: "pass",
			github_event_mode: "webhook",
			webhook_secret: "secret",
			pi_agent_provider: "ollama",
			pi_agent_model: "kimi",
			ollama_container_name: "yolomatic-ollama",
			openai_api_key: "",
		});
		expect(body.github_poll_interval_ms).toBeUndefined();
	});

	it("includes the polling interval and omits the webhook secret for polling mode", () => {
		const body = buildOnboardingBody(baseState({ githubEventMode: "polling", githubPollIntervalMs: "15000", webhookSecret: "" }));
		expect(body.github_event_mode).toBe("polling");
		expect(body.github_poll_interval_ms).toBe("15000");
		expect(body.webhook_secret).toBeUndefined();
	});

	it("includes both interval and secret for both mode", () => {
		const body = buildOnboardingBody(baseState({ githubEventMode: "both", githubPollIntervalMs: "30000", webhookSecret: "wh" }));
		expect(body.github_event_mode).toBe("both");
		expect(body.github_poll_interval_ms).toBe("30000");
		expect(body.webhook_secret).toBe("wh");
	});

	it("normalizes a valid polling interval to its trimmed integer string", () => {
		const body = buildOnboardingBody(baseState({ githubEventMode: "polling", githubPollIntervalMs: "  45000  ", webhookSecret: "" }));
		expect(body.github_poll_interval_ms).toBe("45000");
	});

	it("omits the polling interval when it is invalid", () => {
		const body = buildOnboardingBody(baseState({ githubEventMode: "polling", githubPollIntervalMs: "abc", webhookSecret: "" }));
		expect(body.github_poll_interval_ms).toBeUndefined();
	});

	it("trims all free-text fields", () => {
		const body = buildOnboardingBody(
			baseState({
				githubEventMode: "webhook",
				adminFullName: "  Admin  ",
				adminUsername: "  admin  ",
				adminPassword: "  pass  ",
				githubToken: "  ghp_test  ",
				githubUsername: "  octocat  ",
				webhookSecret: "  secret  ",
				piAgentProvider: "  ollama  ",
				piAgentModel: "  kimi  ",
				ollamaContainerName: "  yolomatic-ollama  ",
				openaiApiKey: "  sk-key  ",
			}),
		);
		expect(body.admin_full_name).toBe("Admin");
		expect(body.admin_username).toBe("admin");
		expect(body.admin_password).toBe("pass");
		expect(body.github_token).toBe("ghp_test");
		expect(body.github_username).toBe("octocat");
		expect(body.webhook_secret).toBe("secret");
		expect(body.pi_agent_provider).toBe("ollama");
		expect(body.pi_agent_model).toBe("kimi");
		expect(body.ollama_container_name).toBe("yolomatic-ollama");
		expect(body.openai_api_key).toBe("sk-key");
	});

	it("preserves protected secrets by submitting empty values", () => {
		const body = buildOnboardingBody(
			baseState({
				githubEventMode: "webhook",
				githubToken: "",
				githubTokenProtected: true,
				adminPassword: "",
				adminPasswordProtected: true,
				webhookSecret: "",
				webhookSecretProtected: true,
				openaiApiKey: "",
				openaiApiKeyProtected: true,
			}),
		);
		expect(body.github_token).toBe("");
		expect(body.admin_password).toBe("");
		expect(body.webhook_secret).toBe("");
		expect(body.openai_api_key).toBe("");
	});

	it("ignores repository, step, and error fields from the full wizard state", () => {
		const full = baseState({
			step: 5,
			githubEventMode: "webhook",
			webhookSecret: "secret",
			repositories: [{ owner: "mbrooks", repo: "yolomatic", fullName: "mbrooks/yolomatic", selected: true, configured: false }],
			error: null,
		});
		const body = buildOnboardingBody(full);
		expect(body.github_event_mode).toBe("webhook");
		expect(body).not.toHaveProperty("repositories");
		expect(body).not.toHaveProperty("step");
		expect(body).not.toHaveProperty("error");
	});
});