import { describe, expect, it } from "vitest";

import { describeModelRun, formatTokenCount, providerDisplayName } from "./model-log.js";
import type { ModelRunInfo } from "./model-log.js";

function makeModelRunInfo(overrides: Partial<ModelRunInfo> = {}): ModelRunInfo {
	return {
		provider: "ollama",
		id: "deepseek-v4-flash:0731-cloud",
		api: "openai-completions",
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		...overrides,
	};
}

describe("formatTokenCount", () => {
	it("renders exact binary multiples compactly", () => {
		expect(formatTokenCount(1_048_576)).toBe("1M");
		expect(formatTokenCount(65_536)).toBe("64K");
		expect(formatTokenCount(16_384)).toBe("16K");
		expect(formatTokenCount(2_048)).toBe("2K");
	});

	it("falls back to decimal compact notation for non-multiples of 1024", () => {
		expect(formatTokenCount(400_000)).toBe("400K");
		expect(formatTokenCount(128_000)).toBe("128K");
	});

	it("passes small counts through unchanged", () => {
		expect(formatTokenCount(999)).toBe("999");
	});
});

describe("providerDisplayName", () => {
	it("maps known provider ids to display names", () => {
		expect(providerDisplayName("ollama")).toBe("Ollama");
		expect(providerDisplayName("openai")).toBe("OpenAI");
	});

	it("capitalizes unknown provider ids", () => {
		expect(providerDisplayName("anthropic")).toBe("Anthropic");
	});
});

describe("describeModelRun", () => {
	it("produces the model run sentence for a reasoning-enabled ollama model at medium effort", () => {
		const message = describeModelRun(makeModelRunInfo(), "medium");
		expect(message).toBe(
			"Running on deepseek-v4-flash:0731-cloud, served through Ollama (openai-completions API). " +
			"Reasoning is enabled at medium effort, with a 1M-token context window and 64K max output tokens.",
		);
	});

	it("reports reasoning disabled when the thinking level is off", () => {
		const message = describeModelRun(makeModelRunInfo(), "off");
		expect(message).toBe(
			"Running on deepseek-v4-flash:0731-cloud, served through Ollama (openai-completions API). " +
			"Reasoning is disabled, with a 1M-token context window and 64K max output tokens.",
		);
	});

	it("reports reasoning disabled when the model does not support reasoning", () => {
		const message = describeModelRun(makeModelRunInfo({ reasoning: false }), "high");
		expect(message).toContain("Reasoning is disabled, with a 1M-token context window");
		expect(message).not.toContain("high effort");
	});

	it("renders an openai model with its provider name, api, and decimal-compact limits", () => {
		const message = describeModelRun(
			makeModelRunInfo({
				provider: "openai",
				id: "gpt-5.2",
				api: "openai-responses",
				contextWindow: 400_000,
				maxTokens: 128_000,
			}),
			"high",
		);
		expect(message).toBe(
			"Running on gpt-5.2, served through OpenAI (openai-responses API). " +
			"Reasoning is enabled at high effort, with a 400K-token context window and 128K max output tokens.",
		);
	});

	it("renders all reasoning levels", () => {
		expect(describeModelRun(makeModelRunInfo(), "low")).toContain(
			"Reasoning is enabled at low effort",
		);
		expect(describeModelRun(makeModelRunInfo(), "xhigh")).toContain(
			"Reasoning is enabled at xhigh effort",
		);
	});
});