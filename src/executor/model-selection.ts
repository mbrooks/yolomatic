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

/**
 * Prompt kinds the control plane can launch a worker session for. Mirrors the
 * `prompt.kind` union used by the worker protocol minus the in-process-only
 * `override` kind, which never reaches a container launch.
 */
export type WorkerPromptKind = "issue" | "comment" | "pr-review" | "issue-refinement";

/**
 * The model-settings slice consumed by {@link resolveLaunchModel}: the default
 * `pi_agent_model` plus the per-session build and refinement overrides.
 */
export interface LaunchModelSettings {
	piAgentModel?: string;
	piAgentBuildModel?: string;
	piAgentRefinementModel?: string;
}

/**
 * Resolve the model identifier to forward to a worker container as
 * `PI_AGENT_MODEL` for a launch of the given kind.
 *
 * Refinement launches use the refinement model; every other launch (initial
 * issue builds, feedback passes, PR-review passes, and launches that do not
 * report a kind) is a build session and uses the build model. Each falls back
 * to the default model when its specialized value is unset, and to
 * `undefined` when nothing is configured so workers keep pi-defaults
 * behavior.
 */
export function resolveLaunchModel(
	models: LaunchModelSettings,
	kind?: WorkerPromptKind,
): string | undefined {
	const specialized =
		kind === "issue-refinement" ? models.piAgentRefinementModel?.trim() : models.piAgentBuildModel?.trim();
	return specialized || models.piAgentModel?.trim() || undefined;
}
