import { describe, expect, it } from "vitest";
import { extractTokenUsage, mergeUsage, type TokenUsage } from "./usage.js";

describe("extractTokenUsage", () => {
	it("returns unavailable usage with zeros when no assistant messages exist", () => {
		const result = extractTokenUsage([
			{ role: "user", content: "hi" },
			{ role: "toolResult", toolName: "bash", content: [] },
		]);
		expect(result.available).toBe(false);
		expect(result.totalTokens).toBe(0);
		expect(result.input).toBe(0);
		expect(result.output).toBe(0);
		expect(result.cost).toBe(0);
	});

	it("returns unavailable usage when assistant messages lack usage fields", () => {
		const result = extractTokenUsage([
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		]);
		expect(result.available).toBe(false);
		expect(result.totalTokens).toBe(0);
	});

	it("sums usage across assistant messages with usage objects", () => {
		const result = extractTokenUsage([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
				},
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "again" }],
				usage: {
					input: 20,
					output: 7,
					cacheRead: 3,
					cacheWrite: 1,
					totalTokens: 27,
					cost: { input: 0.4, output: 0.5, cacheRead: 0.05, cacheWrite: 0.01, total: 0.96 },
				},
			},
		]);
		expect(result.available).toBe(true);
		expect(result.input).toBe(30);
		expect(result.output).toBe(12);
		expect(result.totalTokens).toBe(42);
		expect(result.cost).toBeCloseTo(1.26, 10);
	});

	it("ignores usage reported on non-assistant messages", () => {
		const result = extractTokenUsage([
			{
				role: "toolResult",
				toolName: "bash",
				content: [],
				usage: {
					input: 100,
					output: 100,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 200,
					cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
				},
			},
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		]);
		expect(result.available).toBe(false);
	});

	it("treats missing totalTokens as the sum of input and output when present", () => {
		const result = extractTokenUsage([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				usage: {
					input: 4,
					output: 6,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		]);
		expect(result.available).toBe(true);
		expect(result.totalTokens).toBe(10);
		expect(result.input).toBe(4);
		expect(result.output).toBe(6);
	});

	it("is available when at least one assistant message reports any usage number", () => {
		const result = extractTokenUsage([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			},
		]);
		expect(result.available).toBe(true);
	});

	it("returns a stable empty shape for nullish input", () => {
		const result = extractTokenUsage(undefined as unknown as unknown[]);
		const expected: TokenUsage = {
			available: false,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: 0,
		};
		expect(result).toEqual(expected);
	});
});
describe("extractTokenUsage edge branches", () => {
	it("ignores non-object message entries (null, string, number)", () => {
		const result = extractTokenUsage([
			null,
			"not-an-object",
			42,
			{ role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 7, output: 3, totalTokens: 10 } },
		] as unknown[]);
		expect(result.available).toBe(true);
		expect(result.totalTokens).toBe(10);
	});

	it("treats an assistant message with only a cost field as available usage", () => {
		const result = extractTokenUsage([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				usage: { cost: { total: 0.5 } },
			},
		]);
		expect(result.available).toBe(true);
		expect(result.cost).toBeCloseTo(0.5, 10);
		expect(result.totalTokens).toBe(0);
	});

	it("treats an assistant message with only cacheRead as available usage", () => {
		const result = extractTokenUsage([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				usage: { cacheRead: 9 },
			},
		]);
		expect(result.available).toBe(true);
		expect(result.cacheRead).toBe(9);
		expect(result.totalTokens).toBe(9);
	});

	it("treats an assistant message with only cacheWrite as available usage", () => {
		const result = extractTokenUsage([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				usage: { cacheWrite: 4 },
			},
		]);
		expect(result.available).toBe(true);
		expect(result.cacheWrite).toBe(4);
	});

	it("treats an assistant message with only output as available usage", () => {
		const result = extractTokenUsage([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				usage: { output: 6 },
			},
		]);
		expect(result.available).toBe(true);
		expect(result.output).toBe(6);
		expect(result.totalTokens).toBe(6);
	});

	it("treats an assistant message with only totalTokens as available usage", () => {
		const result = extractTokenUsage([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				usage: { totalTokens: 11 },
			},
		]);
		expect(result.available).toBe(true);
		expect(result.totalTokens).toBe(11);
	});

	it("returns unavailable when an assistant usage object has none of the recognized fields", () => {
		const result = extractTokenUsage([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				usage: {},
			},
		]);
		expect(result.available).toBe(false);
	});

	it("falls back to input+output+cache sum when totalTokens is not a number", () => {
		const result = extractTokenUsage([
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				usage: { input: 4, output: 6, cacheRead: 1, cacheWrite: 2 },
			},
		]);
		expect(result.available).toBe(true);
		expect(result.totalTokens).toBe(13);
	});
});

describe("mergeUsage", () => {
	it("returns next unchanged when no prior snapshot is provided", () => {
		const next: TokenUsage = {
			available: true,
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: 0.3,
		};
		expect(mergeUsage(undefined, next)).toEqual(next);
	});

	it("adds numeric fields and ORs availability across snapshots", () => {
		const prior: TokenUsage = {
			available: true,
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: 0.3,
		};
		const next: TokenUsage = {
			available: false,
			input: 20,
			output: 7,
			cacheRead: 3,
			cacheWrite: 1,
			totalTokens: 27,
			cost: 0.96,
		};
		const merged = mergeUsage(prior, next);
		expect(merged.available).toBe(true);
		expect(merged.input).toBe(30);
		expect(merged.output).toBe(12);
		expect(merged.cacheRead).toBe(3);
		expect(merged.cacheWrite).toBe(1);
		expect(merged.totalTokens).toBe(42);
		expect(merged.cost).toBeCloseTo(1.26, 10);
	});

	it("preserves prior availability when the next snapshot is unavailable", () => {
		const prior: TokenUsage = {
			available: true,
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: 0.3,
		};
		const next: TokenUsage = {
			available: false,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: 0,
		};
		const merged = mergeUsage(prior, next);
		expect(merged.available).toBe(true);
		expect(merged.totalTokens).toBe(15);
	});
});
