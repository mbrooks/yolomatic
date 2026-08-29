// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from "vitest";

import {
	STORAGE_KEY,
	TOTAL_STEPS,
	DEFAULT_OLLAMA_CONTAINER_NAME,
	generatePassword,
	getDefaultState,
	saveState,
	readStoredState,
	applyConfig,
	mergeStoredState,
	buildInitialState,
	mergeAccessibleRepos,
	repoKey,
	type WizardState,
} from "./wizard-state.js";
import type { OnboardingConfig } from "../../api/onboarding.js";

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

function storedOverrides(overrides: Partial<WizardState>): WizardState {
	return { ...getDefaultState(), ...overrides } as WizardState;
}

beforeEach(() => {
	localStorage.clear();
});

describe("constants", () => {
	it("uses the documented storage key and step count", () => {
		expect(STORAGE_KEY).toBe("yolomatic-onboarding-wizard");
		expect(TOTAL_STEPS).toBe(5);
	});

	it("uses yolomatic-ollama as the default ollama container name", () => {
		expect(DEFAULT_OLLAMA_CONTAINER_NAME).toBe("yolomatic-ollama");
	});
});

describe("generatePassword", () => {
	it("returns a non-empty string", () => {
		expect(generatePassword().length).toBeGreaterThan(0);
	});

	it("produces different values across calls", () => {
		expect(generatePassword()).not.toBe(generatePassword());
	});
});

describe("getDefaultState", () => {
	it("starts on step 1 with ollama defaults and no protected secrets", () => {
		const state = getDefaultState();
		expect(state.step).toBe(1);
		expect(state.adminUsername).toBe("admin");
		expect(state.adminFullName).toBe("Admin");
		expect(state.adminPassword.length).toBeGreaterThan(0);
		expect(state.adminPasswordProtected).toBe(false);
		expect(state.githubTokenProtected).toBe(false);
		expect(state.webhookSecretProtected).toBe(false);
		expect(state.openaiApiKeyProtected).toBe(false);
		expect(state.githubUsernameConfirmed).toBe(false);
		expect(state.githubEventMode).toBe("");
		expect(state.githubPollIntervalMs).toBe("");
		expect(state.piAgentProvider).toBe("ollama");
		expect(state.piAgentModel).toBe("");
		expect(state.ollamaContainerName).toBe(DEFAULT_OLLAMA_CONTAINER_NAME);
		expect(state.repositories).toEqual([]);
		expect(state.error).toBeNull();
		// No pull attempt has settled for the planned model; nothing is blocking.
		expect(state.piAgentModelPullOutcome).toBeNull();
	});
});

describe("saveState / readStoredState", () => {
	it("round-trips state through localStorage", () => {
		const state = storedOverrides({ step: 3, adminUsername: "alice" });
		saveState(state);
		expect(readStoredState()).toEqual(state);
	});

	it("returns null when nothing is stored", () => {
		expect(readStoredState()).toBeNull();
	});

	it("returns null when the stored payload is invalid JSON", () => {
		localStorage.setItem(STORAGE_KEY, "{not json");
		expect(readStoredState()).toBeNull();
	});

	it("swallows storage write failures", () => {
		const original = localStorage.setItem;
		localStorage.setItem = () => {
			throw new Error("quota");
		};
		expect(() => saveState(getDefaultState())).not.toThrow();
		localStorage.setItem = original;
	});
});

describe("applyConfig", () => {
	it("pre-populates admin name and username from configuration", () => {
		const state = getDefaultState();
		applyConfig(state, { ...emptyConfig(), admin_full_name: "Ada", admin_username: "ada" });
		expect(state.adminFullName).toBe("Ada");
		expect(state.adminUsername).toBe("ada");
	});

	it("ignores blank admin name and username", () => {
		const state = getDefaultState();
		applyConfig(state, { ...emptyConfig(), admin_full_name: "  ", admin_username: "" });
		expect(state.adminFullName).toBe("Admin");
		expect(state.adminUsername).toBe("admin");
	});

	it("marks a configured admin password as protected and clears the field", () => {
		const state = getDefaultState();
		applyConfig(state, { ...emptyConfig(), admin_password: { configured: true } });
		expect(state.adminPassword).toBe("");
		expect(state.adminPasswordProtected).toBe(true);
	});

	it("marks configured github token, webhook secret, and openai key as protected", () => {
		const state = getDefaultState();
		applyConfig(state, {
			...emptyConfig(),
			github_token: { configured: true },
			webhook_secret: { configured: true },
			openai_api_key: { configured: true },
		});
		expect(state.githubTokenProtected).toBe(true);
		expect(state.webhookSecretProtected).toBe(true);
		expect(state.openaiApiKeyProtected).toBe(true);
	});

	it("pre-populates and confirms the github username", () => {
		const state = getDefaultState();
		applyConfig(state, { ...emptyConfig(), github_username: "octocat" });
		expect(state.githubUsername).toBe("octocat");
		expect(state.githubUsernameConfirmed).toBe(true);
	});

	it("applies a valid event mode and polling interval", () => {
		const state = getDefaultState();
		applyConfig(state, { ...emptyConfig(), github_event_mode: "polling", github_poll_interval_ms: "15000" });
		expect(state.githubEventMode).toBe("polling");
		expect(state.githubPollIntervalMs).toBe("15000");
	});

	it("ignores an invalid event mode", () => {
		const state = getDefaultState();
		applyConfig(state, { ...emptyConfig(), github_event_mode: "bogus" });
		expect(state.githubEventMode).toBe("");
	});

	it("ignores an invalid polling interval", () => {
		const state = getDefaultState();
		applyConfig(state, { ...emptyConfig(), github_event_mode: "polling", github_poll_interval_ms: "abc" });
		expect(state.githubPollIntervalMs).toBe("");
	});

	it("pre-populates AI / LLM provider, model, and container name", () => {
		const state = getDefaultState();
		applyConfig(state, {
			...emptyConfig(),
			pi_agent_provider: "openai",
			pi_agent_model: "gpt",
			ollama_container_name: "custom-ollama",
		});
		expect(state.piAgentProvider).toBe("openai");
		expect(state.piAgentModel).toBe("gpt");
		expect(state.ollamaContainerName).toBe("custom-ollama");
	});

	it("ignores blank AI / LLM values", () => {
		const state = getDefaultState();
		applyConfig(state, {
			...emptyConfig(),
			pi_agent_provider: "  ",
			pi_agent_model: "",
			ollama_container_name: "  ",
		});
		expect(state.piAgentProvider).toBe("ollama");
		expect(state.piAgentModel).toBe("");
		expect(state.ollamaContainerName).toBe(DEFAULT_OLLAMA_CONTAINER_NAME);
	});
});

describe("mergeStoredState", () => {
	it("overlays stored values on the base and clears the error", () => {
		const base = getDefaultState();
		const stored = storedOverrides({ step: 4, adminUsername: "in-progress", error: "boom" });
		const merged = mergeStoredState(base, stored);
		expect(merged.step).toBe(4);
		expect(merged.adminUsername).toBe("in-progress");
		expect(merged.error).toBeNull();
	});

	it("unprotects the admin password when a replacement value is present", () => {
		const merged = mergeStoredState(getDefaultState(), storedOverrides({ adminPassword: "new-pass", adminPasswordProtected: true }));
		expect(merged.adminPasswordProtected).toBe(false);
	});

	it("unprotects the github token, webhook secret, and openai key when replacements are present", () => {
		const merged = mergeStoredState(
			getDefaultState(),
			storedOverrides({
				githubToken: "ghp_new",
				githubTokenProtected: true,
				webhookSecret: "new-secret",
				webhookSecretProtected: true,
				openaiApiKey: "sk-new",
				openaiApiKeyProtected: true,
			}),
		);
		expect(merged.githubTokenProtected).toBe(false);
		expect(merged.webhookSecretProtected).toBe(false);
		expect(merged.openaiApiKeyProtected).toBe(false);
	});

	it("keeps protected flags when no replacement value is present", () => {
		const merged = mergeStoredState(
			getDefaultState(),
			storedOverrides({ adminPassword: "", adminPasswordProtected: true, githubToken: "", githubTokenProtected: true }),
		);
		expect(merged.adminPasswordProtected).toBe(true);
		expect(merged.githubTokenProtected).toBe(true);
	});
});

describe("buildInitialState", () => {
	it("returns defaults when no config is provided", () => {
		const state = buildInitialState(null);
		expect(state.step).toBe(1);
		expect(state.adminUsername).toBe("admin");
		expect(state.piAgentProvider).toBe("ollama");
	});

	it("applies configuration when no stored state exists", () => {
		localStorage.clear();
		const state = buildInitialState({ ...emptyConfig(), admin_username: "bob" });
		expect(state.adminUsername).toBe("bob");
	});

	it("preserves in-progress localStorage state over config for edited fields", () => {
		saveState(storedOverrides({ step: 2, adminUsername: "in-progress-admin", adminPassword: "typed-pass", githubEventMode: "polling", githubPollIntervalMs: "20000" }));
		const state = buildInitialState({ ...emptyConfig(), admin_username: "configured-admin", admin_password: { configured: true }, github_event_mode: "webhook", github_poll_interval_ms: "15000" });
		expect(state.step).toBe(2);
		expect(state.adminUsername).toBe("in-progress-admin");
		expect(state.adminPassword).toBe("typed-pass");
		expect(state.githubEventMode).toBe("polling");
		expect(state.githubPollIntervalMs).toBe("20000");
	});
});

describe("repoKey", () => {
	it("lowercases the owner/repo pair", () => {
		expect(repoKey("Mbrooks", "Yolomatic")).toBe("mbrooks/yolomatic");
	});
});

describe("mergeAccessibleRepos", () => {
	const accessible = [
		{ owner: "mbrooks", repo: "yolomatic", fullName: "mbrooks/yolomatic" },
		{ owner: "octocat", repo: "hello", fullName: "octocat/hello" },
	];

	it("pre-selects every accessible repo on first run when nothing is configured", () => {
		const merged = mergeAccessibleRepos(accessible, [], []);
		expect(merged).toHaveLength(2);
		expect(merged.every((r) => r.selected)).toBe(true);
		expect(merged.map((r) => r.fullName)).toEqual(["mbrooks/yolomatic", "octocat/hello"]);
	});

	it("pre-selects only configured repos when rerunning with existing configuration", () => {
		const merged = mergeAccessibleRepos(accessible, [{ owner: "mbrooks", repo: "yolomatic" }], []);
		const byName = new Map(merged.map((r) => [r.fullName, r]));
		expect(byName.get("mbrooks/yolomatic")?.selected).toBe(true);
		expect(byName.get("mbrooks/yolomatic")?.configured).toBe(true);
		expect(byName.get("octocat/hello")?.selected).toBe(false);
		expect(byName.get("octocat/hello")?.configured).toBe(false);
	});

	it("preserves previous in-progress selection state", () => {
		const previous = [{ owner: "octocat", repo: "hello", fullName: "octocat/hello", selected: false, configured: false }];
		const merged = mergeAccessibleRepos(accessible, [], previous);
		const byName = new Map(merged.map((r) => [r.fullName, r]));
		expect(byName.get("octocat/hello")?.selected).toBe(false);
		expect(byName.get("mbrooks/yolomatic")?.selected).toBe(true);
	});

	it("retains configured repos that are no longer accessible", () => {
		const merged = mergeAccessibleRepos(accessible, [{ owner: "lost", repo: "repo" }], []);
		const byName = new Map(merged.map((r) => [r.fullName, r]));
		expect(byName.get("lost/repo")?.configured).toBe(true);
		expect(byName.get("lost/repo")?.selected).toBe(true);
	});

	it("sorts merged repositories by full name", () => {
		const merged = mergeAccessibleRepos(
			[
				{ owner: "zeta", repo: "z", fullName: "zeta/z" },
				{ owner: "alpha", repo: "a", fullName: "alpha/a" },
			],
			[],
			[],
		);
		expect(merged.map((r) => r.fullName)).toEqual(["alpha/a", "zeta/z"]);
	});
});