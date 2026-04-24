import { describe, expect, it } from "vitest";

import { resolveConfiguredModel } from "./index.js";

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
			{ provider: "ollama", id: "kimi-k2.6:cloud" },
		]);

		const model = resolveConfiguredModel(registry, {
			PI_AGENT_PROVIDER: "ollama",
			PI_AGENT_MODEL: "kimi-k2.6:cloud",
		});

		expect(model).toEqual({ provider: "ollama", id: "kimi-k2.6:cloud" });
	});

	it("resolves a unique model id without an explicit provider", () => {
		const registry = createRegistry([
			{ provider: "github-copilot", id: "gpt-4o" },
			{ provider: "ollama", id: "kimi-k2.6:cloud" },
		]);

		const model = resolveConfiguredModel(registry, {
			PI_AGENT_MODEL: "kimi-k2.6:cloud",
		});

		expect(model).toEqual({ provider: "ollama", id: "kimi-k2.6:cloud" });
	});

	it("supports provider/model syntax in PI_AGENT_MODEL", () => {
		const registry = createRegistry([
			{ provider: "github-copilot", id: "gpt-4o" },
			{ provider: "ollama", id: "kimi-k2.6:cloud" },
		]);

		const model = resolveConfiguredModel(registry, {
			PI_AGENT_MODEL: "ollama/kimi-k2.6:cloud",
		});

		expect(model).toEqual({ provider: "ollama", id: "kimi-k2.6:cloud" });
	});

	it("returns undefined for ambiguous model ids", () => {
		const registry = createRegistry([
			{ provider: "provider-a", id: "shared-model" },
			{ provider: "provider-b", id: "shared-model" },
		]);

		const model = resolveConfiguredModel(registry, {
			PI_AGENT_MODEL: "shared-model",
		});

		expect(model).toBeUndefined();
	});
});
