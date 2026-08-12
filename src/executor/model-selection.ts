export interface ModelReference {
	provider: string;
	id: string;
}

export interface ModelLookup<TModel extends ModelReference> {
	find(provider: string, modelId: string): TModel | undefined;
	getAll(): TModel[];
}

export interface ConfiguredModelOverride {
	provider?: string;
	model?: string;
}

/**
 * Model-settings fallback consumed by {@link resolveConfiguredModel}. This is
 * a subset of {@link ModelSettings} carrying only the model id/provider
 * fields; callers pass the relevant slice of their injected runtime settings.
 */
export interface ModelSettingsFallback {
	piAgentModel?: string;
	piAgentProvider?: string;
}

export function resolveConfiguredModel<TModel extends ModelReference>(
	registry: ModelLookup<TModel>,
	override?: ConfiguredModelOverride,
	fallback?: ModelSettingsFallback,
): TModel | undefined {
	const configuredModel = override?.model?.trim() || fallback?.piAgentModel?.trim();
	if (!configuredModel) {
		return undefined;
	}

	const configuredProvider = override?.provider?.trim() || fallback?.piAgentProvider?.trim();
	if (configuredProvider) {
		return registry.find(configuredProvider, configuredModel);
	}

	const exactMatches = registry
		.getAll()
		.filter((model) => model.id === configuredModel || `${model.provider}/${model.id}` === configuredModel);
	if (exactMatches.length === 1) {
		return exactMatches[0];
	}

	const slashIndex = configuredModel.indexOf("/");
	if (slashIndex > 0) {
		const provider = configuredModel.slice(0, slashIndex).trim();
		const modelId = configuredModel.slice(slashIndex + 1).trim();
		if (provider && modelId) {
			return registry.find(provider, modelId);
		}
	}

	return undefined;
}
