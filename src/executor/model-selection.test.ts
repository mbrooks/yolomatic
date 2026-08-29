import { describe, expect, it } from "vitest";

import {
	resolveConfiguredModel,
	resolveLaunchModel,
	type LaunchModelSettings,
} from "./model-selection.js";

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

	it("supports provider/model syntax in the configured model", () => {
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

		expect(resolveConfiguredModel(registry, undefined)).toBeUndefined();
	});

	it("falls back to provider/model parsing when the combined id is ambiguous", () => {
		const registry = createRegistry([
			{ provider: "provider-a", id: "provider-b/shared-model" },
			{ provider: "provider-b", id: "shared-model" },
		]);

		const model = resolveConfiguredModel(registry, { model: "provider-b/shared-model" });

		expect(model).toEqual({ provider: "provider-b", id: "shared-model" });
	});

	it("falls back to injected model settings when no override is provided", () => {
		const registry = createRegistry([{ provider: "ollama", id: "kimi-k2.7-code:cloud" }]);

		const model = resolveConfiguredModel(
			registry,
			undefined,
			{ piAgentProvider: "ollama", piAgentModel: "kimi-k2.7-code:cloud" },
		);

		expect(model).toEqual({ provider: "ollama", id: "kimi-k2.7-code:cloud" });
	});

	it("resolves an openai model given piAgentProvider=openai", () => {
		const registry = createRegistry([
			{ provider: "ollama", id: "kimi-k2.7-code:cloud" },
			{ provider: "openai", id: "gpt-5.2" },
			{ provider: "openai", id: "gpt-5.2-codex" },
		]);

		const model = resolveConfiguredModel(
			registry,
			undefined,
			{ piAgentProvider: "openai", piAgentModel: "gpt-5.2-codex" },
		);

		expect(model).toEqual({ provider: "openai", id: "gpt-5.2-codex" });
	});

	it("returns undefined when fallback is omitted and no override is provided", () => {
		const registry = createRegistry([{ provider: "ollama", id: "kimi-k2.7-code:cloud" }]);

		expect(resolveConfiguredModel(registry, undefined)).toBeUndefined();
	});

});

describe("resolveLaunchModel", () => {
	const allModels: LaunchModelSettings = {
		piAgentModel: "default-model",
		piAgentBuildModel: "build-model",
		piAgentRefinementModel: "refinement-model",
	};

	it("resolves the build model for issue build launch kinds", () => {
		expect(resolveLaunchModel(allModels, "issue")).toBe("build-model");
		expect(resolveLaunchModel(allModels, "comment")).toBe("build-model");
		expect(resolveLaunchModel(allModels, "pr-review")).toBe("build-model");
	});

	it("resolves the refinement model for issue-refinement launches", () => {
		expect(resolveLaunchModel(allModels, "issue-refinement")).toBe("refinement-model");
	});

	it("falls back to the default model when the build model is unset", () => {
		expect(
			resolveLaunchModel(
				{ piAgentModel: "default-model", piAgentRefinementModel: "refinement-model" },
				"comment",
			),
		).toBe("default-model");
	});

	it("falls back to the default model when the refinement model is unset", () => {
		expect(
			resolveLaunchModel(
				{ piAgentModel: "default-model", piAgentBuildModel: "build-model" },
				"issue-refinement",
			),
		).toBe("default-model");
	});

	it("returns undefined when no model is configured", () => {
		expect(resolveLaunchModel({}, "issue")).toBeUndefined();
		expect(resolveLaunchModel({}, "issue-refinement")).toBeUndefined();
		expect(resolveLaunchModel({}, undefined)).toBeUndefined();
	});

	it("treats blank specialized values as unset", () => {
		expect(
			resolveLaunchModel({ piAgentModel: "default-model", piAgentBuildModel: "   " }, "issue"),
		).toBe("default-model");
		expect(
			resolveLaunchModel({ piAgentModel: "default-model", piAgentRefinementModel: "" }, "issue-refinement"),
		).toBe("default-model");
	});

	it("trims the resolved model identifier", () => {
		expect(resolveLaunchModel({ piAgentBuildModel: "  build-model  " }, "pr-review")).toBe("build-model");
		expect(resolveLaunchModel({ piAgentRefinementModel: " refinement-model " }, "issue-refinement")).toBe(
			"refinement-model",
		);
	});

	it("treats a launch with no known kind as a build launch", () => {
		expect(resolveLaunchModel(allModels, undefined)).toBe("build-model");
	});
});
