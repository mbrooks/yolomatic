import { describe, expect, it } from "vitest";

import { resolveConfiguredModel } from "./model-selection.js";

interface TestModel {
	provider: string;
	id: string;
}

function createRegistry(models: TestModel[]) {
	return {
		find(provider: string, modelId: string): TestModel | undefined {
			return models.find((model) => model.provider === provider && model.id === modelId);
		},
		getAll(): TestModel[] {
			return models;
		},
	};
}

describe("resolveConfiguredModel", () => {
	it("prefers an explicit provider when configured", () => {
		const registry = createRegistry([
			{ provider: "github-copilot", id: "gpt-4o" },
			{ provider: "ollama", id: "kimi-k2.7-code:cloud" },
		]);

		const model = resolveConfiguredModel(registry, {
			provider: "ollama",
			model: "kimi-k2.7-code:cloud",
		});

		expect(model).toEqual({ provider: "ollama", id: "kimi-k2.7-code:cloud" });
	});

	it("resolves a unique model id without an explicit provider", () => {
		const registry = createRegistry([
			{ provider: "github-copilot", id: "gpt-4o" },
			{ provider: "ollama", id: "kimi-k2.7-code:cloud" },
		]);

		const model = resolveConfiguredModel(registry, { model: "kimi-k2.7-code:cloud" });

		expect(model).toEqual({ provider: "ollama", id: "kimi-k2.7-code:cloud" });
	});

	it("supports provider/model syntax in PI_AGENT_MODEL", () => {
		const registry = createRegistry([
			{ provider: "github-copilot", id: "gpt-4o" },
			{ provider: "ollama", id: "kimi-k2.7-code:cloud" },
		]);

		const model = resolveConfiguredModel(registry, { model: "ollama/kimi-k2.7-code:cloud" });

		expect(model).toEqual({ provider: "ollama", id: "kimi-k2.7-code:cloud" });
	});

	it("returns undefined for ambiguous model ids", () => {
		const registry = createRegistry([
			{ provider: "provider-a", id: "shared-model" },
			{ provider: "provider-b", id: "shared-model" },
		]);

		const model = resolveConfiguredModel(registry, { model: "shared-model" });

		expect(model).toBeUndefined();
	});

	it("returns undefined when no model is configured", () => {
		const registry = createRegistry([{ provider: "provider", id: "model" }]);

		expect(resolveConfiguredModel(registry, undefined, {})).toBeUndefined();
	});

	it("falls back to provider/model parsing when the combined id is ambiguous", () => {
		const registry = createRegistry([
			{ provider: "provider-a", id: "provider-b/shared-model" },
			{ provider: "provider-b", id: "shared-model" },
		]);

		const model = resolveConfiguredModel(registry, { model: "provider-b/shared-model" });

		expect(model).toEqual({ provider: "provider-b", id: "shared-model" });
	});

	it("falls back to environment variables when no override is provided", () => {
		const registry = createRegistry([{ provider: "ollama", id: "kimi-k2.7-code:cloud" }]);

		const model = resolveConfiguredModel(
			registry,
			undefined,
			{ PI_AGENT_PROVIDER: "ollama", PI_AGENT_MODEL: "kimi-k2.7-code:cloud" },
		);

		expect(model).toEqual({ provider: "ollama", id: "kimi-k2.7-code:cloud" });
	});
});
