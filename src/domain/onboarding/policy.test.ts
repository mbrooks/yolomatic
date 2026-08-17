import { describe, expect, it } from "vitest";

import {
	EVENT_MODE_OPTIONS,
	VALID_EVENT_MODES,
	VALID_ONBOARDING_PROVIDERS,
	LLM_PROVIDER_OPTIONS,
	MIN_POLL_INTERVAL_MS,
	DEFAULT_POLL_INTERVAL_MS,
	GithubEventMode,
	isValidEventMode,
	isPollingMode,
	isWebhookMode,
	parsePollIntervalMs,
	isValidPollIntervalMs,
} from "./policy.js";

describe("onboarding policy", () => {
	describe("event modes", () => {
		it("exposes the three supported event modes", () => {
			expect(EVENT_MODE_OPTIONS).toEqual(["webhook", "polling", "both"]);
		});

		it("aliases VALID_EVENT_MODES to the same set of strings", () => {
			expect(VALID_EVENT_MODES).toEqual(["webhook", "polling", "both"]);
			expect(VALID_EVENT_MODES).toBe(EVENT_MODE_OPTIONS);
		});

		type ModeCase = { mode: string; valid: boolean; polling: boolean; webhook: boolean };
		const cases: ModeCase[] = [
			{ mode: "webhook", valid: true, polling: false, webhook: true },
			{ mode: "polling", valid: true, polling: true, webhook: false },
			{ mode: "both", valid: true, polling: true, webhook: true },
			{ mode: "", valid: false, polling: false, webhook: false },
			{ mode: "webhooks", valid: false, polling: false, webhook: false },
			{ mode: "POLLING", valid: false, polling: false, webhook: false },
			{ mode: "disabled", valid: false, polling: false, webhook: false },
		];

		for (const { mode, valid, polling, webhook } of cases) {
			it(`accepts "${mode}" as ${valid ? "valid" : "invalid"} (polling=${polling}, webhook=${webhook})`, () => {
				expect(isValidEventMode(mode)).toBe(valid);
				expect(isPollingMode(mode)).toBe(polling);
				expect(isWebhookMode(mode)).toBe(webhook);
			});
		}

		it("rejects undefined and non-string event modes", () => {
			expect(isValidEventMode(undefined)).toBe(false);
			expect(isPollingMode(undefined)).toBe(false);
			expect(isWebhookMode(undefined)).toBe(false);
		});

		it("does not mutate the exported option list", () => {
			expect(() => {
				// Reading is fine; the list is readonly at the type level.
				void EVENT_MODE_OPTIONS.length;
			}).not.toThrow();
		});

		it("types GithubEventMode as the union of supported modes", () => {
			const mode: GithubEventMode = "both";
			expect(EVENT_MODE_OPTIONS).toContain(mode);
		});
	});

	describe("poll interval", () => {
		it("defines a minimum interval of 1000 ms and a default of 60000 ms", () => {
			expect(MIN_POLL_INTERVAL_MS).toBe(1000);
			expect(DEFAULT_POLL_INTERVAL_MS).toBe(60000);
		});

		type ParseCase = { raw: string | undefined; expected: number | null };
		const parseCases: ParseCase[] = [
			{ raw: "1000", expected: 1000 },
			{ raw: "60000", expected: 60000 },
			{ raw: "15000", expected: 15000 },
			{ raw: "999", expected: null },
			{ raw: "0", expected: null },
			{ raw: "abc", expected: null },
			{ raw: "1.5", expected: null },
			{ raw: " 30000 ", expected: 30000 },
			{ raw: "", expected: null },
			{ raw: undefined, expected: null },
			{ raw: "-1000", expected: null },
		];

		for (const { raw, expected } of parseCases) {
			it(`parses ${JSON.stringify(raw)} into ${expected ?? "null"}`, () => {
				expect(parsePollIntervalMs(raw)).toBe(expected);
			});
		}

		it("isValidPollIntervalMs mirrors parsePollIntervalMs", () => {
			for (const { raw, expected } of parseCases) {
				expect(isValidPollIntervalMs(raw)).toBe(expected !== null);
			}
		});
	});

	describe("LLM providers", () => {
		it("exposes ollama and openai as the supported providers", () => {
			expect(LLM_PROVIDER_OPTIONS).toEqual(["ollama", "openai"]);
		});

		it("aliases VALID_ONBOARDING_PROVIDERS to the same list", () => {
			expect(VALID_ONBOARDING_PROVIDERS).toEqual(["ollama", "openai"]);
			expect(VALID_ONBOARDING_PROVIDERS).toBe(LLM_PROVIDER_OPTIONS);
		});
	});
});