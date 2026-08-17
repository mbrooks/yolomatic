import { describe, expect, it } from "vitest";

import { isEventModeStepValid, isAiLlmStepValid } from "./wizard-validation.js";

describe("isEventModeStepValid", () => {
	type Case = {
		name: string;
		mode: string;
		pollInterval: string;
		webhookSecret: string;
		webhookSecretProtected?: boolean;
		valid: boolean;
	};

	const cases: Case[] = [
		{ name: "webhook with secret", mode: "webhook", pollInterval: "", webhookSecret: "secret", valid: true },
		{ name: "webhook with protected secret", mode: "webhook", pollInterval: "", webhookSecret: "", webhookSecretProtected: true, valid: true },
		{ name: "webhook without secret", mode: "webhook", pollInterval: "", webhookSecret: "", valid: false },
		{ name: "webhook with blank secret", mode: "webhook", pollInterval: "", webhookSecret: "   ", valid: false },
		{ name: "polling with valid interval", mode: "polling", pollInterval: "15000", webhookSecret: "", valid: true },
		{ name: "polling without interval", mode: "polling", pollInterval: "", webhookSecret: "", valid: false },
		{ name: "polling below minimum", mode: "polling", pollInterval: "999", webhookSecret: "", valid: false },
		{ name: "polling non-numeric", mode: "polling", pollInterval: "abc", webhookSecret: "", valid: false },
		{ name: "both with interval and secret", mode: "both", pollInterval: "30000", webhookSecret: "secret", valid: true },
		{ name: "both missing interval", mode: "both", pollInterval: "", webhookSecret: "secret", valid: false },
		{ name: "both missing secret", mode: "both", pollInterval: "30000", webhookSecret: "", valid: false },
		{ name: "empty mode", mode: "", pollInterval: "", webhookSecret: "", valid: false },
		{ name: "invalid mode", mode: "disabled", pollInterval: "", webhookSecret: "", valid: false },
	];

	for (const { name, mode, pollInterval, webhookSecret, webhookSecretProtected, valid } of cases) {
		it(`is ${valid ? "valid" : "invalid"} for ${name}`, () => {
			expect(
				isEventModeStepValid(mode, pollInterval, webhookSecret, webhookSecretProtected ?? false),
			).toBe(valid);
		});
	}

	it("defaults webhookSecretProtected to false", () => {
		expect(isEventModeStepValid("webhook", "", "")).toBe(false);
	});
});

describe("isAiLlmStepValid", () => {
	type Case = {
		name: string;
		provider: string;
		model: string;
		containerName: string;
		valid: boolean;
	};

	const cases: Case[] = [
		{ name: "ollama with model and container", provider: "ollama", model: "kimi", containerName: "yolomatic-ollama", valid: true },
		{ name: "ollama missing container", provider: "ollama", model: "kimi", containerName: "", valid: false },
		{ name: "ollama blank container", provider: "ollama", model: "kimi", containerName: "   ", valid: false },
		{ name: "ollama missing model", provider: "ollama", model: "", containerName: "yolomatic-ollama", valid: false },
		{ name: "openai with model", provider: "openai", model: "gpt", containerName: "", valid: true },
		{ name: "openai missing model", provider: "openai", model: "", containerName: "", valid: false },
		{ name: "empty provider", provider: "", model: "kimi", containerName: "yolomatic-ollama", valid: false },
		{ name: "whitespace provider", provider: "  ", model: "kimi", containerName: "yolomatic-ollama", valid: false },
		{ name: "whitespace model", provider: "ollama", model: "  ", containerName: "yolomatic-ollama", valid: false },
		{ name: "trimmed ollama provider", provider: "  ollama  ", model: "kimi", containerName: "yolomatic-ollama", valid: true },
	];

	for (const { name, provider, model, containerName, valid } of cases) {
		it(`is ${valid ? "valid" : "invalid"} for ${name}`, () => {
			expect(isAiLlmStepValid(provider, model, containerName)).toBe(valid);
		});
	}
});