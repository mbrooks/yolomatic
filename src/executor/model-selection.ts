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

export function resolveConfiguredModel<TModel extends ModelReference>(
	registry: ModelLookup<TModel>,
	override?: ConfiguredModelOverride,
	env: NodeJS.ProcessEnv = process.env,
): TModel | undefined {
	const configuredModel = override?.model?.trim() || env.PI_AGENT_MODEL?.trim();
	if (!configuredModel) {
		return undefined;
	}

	const configuredProvider = override?.provider?.trim() || env.PI_AGENT_PROVIDER?.trim();
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
