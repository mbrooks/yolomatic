import React, { useCallback, useEffect, useMemo, useState } from "react";
import { fetchRepoSettings, updateRepoSettings, type RepoSettingView } from "../../api/repo-settings.js";
import { removeRepo } from "../../api/repos.js";
import { pullOllamaModel } from "../../api/ollama.js";
import {
	LlmModelSelect,
	describePullFailure,
	type LlmModelFetcher,
	type LlmModelPullResult,
	type LlmModelPullUpdate,
} from "../settings/LlmModelSelect.js";
import {
	BUILD_MODEL_PROVIDERS,
	composeRepoBuildModelOverride,
	parseRepoBuildModelOverride,
} from "../../../repos/repository.js";
import { fetchLlmModels } from "../../api/settings.js";
import { navigate } from "../../app/routes.js";
import { RepoScopedScreenShell } from "../../components/RepoScopedScreenShell.js";
import { RestartBanner } from "../../components/RestartBanner.js";

/** The build-model setting renders as a provider-aware model dropdown. */
const BUILD_MODEL_SETTING_KEY = "pi_agent_build_model";

const llmModelFetcher: LlmModelFetcher = (provider) => fetchLlmModels(provider);

export function RepoSettingsScreen({
	owner,
	repo,
	onBack,
	onSelectTab,
}: {
	owner: string;
	repo: string;
	onBack: () => void;
	onSelectTab: (tab: "sessions" | "skills" | "issues" | "settings") => void;
}): React.ReactElement {
	const [settings, setSettings] = useState<RepoSettingView[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pendingRestart, setPendingRestart] = useState(false);
	const [edited, setEdited] = useState<Record<string, string>>({});
	const [changedKeys, setChangedKeys] = useState<Set<string>>(new Set());
	// Settled Ollama pull outcomes for the build-model dropdown, mirroring the
	// global settings save gate.
	const [modelPullOutcomes, setModelPullOutcomes] = useState<Record<string, LlmModelPullUpdate | null>>({});
	// Explicit provider pick that is not yet representable in the composed
	// build-model value (selected while no model is chosen); reset after save.
	const [buildModelProviderEdit, setBuildModelProviderEdit] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const data = await fetchRepoSettings(owner, repo);
			setSettings(data.settings);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [owner, repo]);

	useEffect(() => {
		void load();
	}, [load]);

	const handleChange = useCallback((key: string, value: string) => {
		setEdited((prev) => ({ ...prev, [key]: value }));
		setChangedKeys((prev) => new Set(prev).add(key));
	}, []);

	const buildModelSetting = settings.find((setting) => setting.key === BUILD_MODEL_SETTING_KEY);
	// Provider that inherited and bare-id build-model overrides resolve
	// against: the global pi_agent_provider, surfaced by the backend view.
	const buildModelProviderDefault = buildModelSetting?.providerDefault?.trim() || "ollama";
	const handleBuildModelPullResult = useCallback((outcome: LlmModelPullUpdate) => {
		setModelPullOutcomes((prev) => ({ ...prev, [BUILD_MODEL_SETTING_KEY]: outcome }));
	}, []);

	// Effective provider is derived before the save handler because the handler
	// gates on it; it depends only on settings + edits.
	const handleSave = useCallback(async () => {
		if (changedKeys.size === 0) {
			return;
		}
		setSaving(true);
		setError(null);
		try {
			// A custom Ollama identifier whose pull failed (or has not settled)
			// must not be persisted: validate the pending build-model override
			// before sending the PATCH, mirroring the global settings save gate.
			if (changedKeys.has(BUILD_MODEL_SETTING_KEY)) {
				const pending = String(edited[BUILD_MODEL_SETTING_KEY] ?? "").trim();
				if (pending !== "") {
					const target = parseRepoBuildModelOverride(pending);
					if ((target.provider || buildModelProviderDefault) === "ollama") {
						const settled =
							modelPullOutcomes[BUILD_MODEL_SETTING_KEY]?.model === target.model
								? modelPullOutcomes[BUILD_MODEL_SETTING_KEY]
								: null;
						// The Ollama pull always targets the bare model identifier,
						// never the composed provider/model string.
						const pullResult: LlmModelPullResult = settled
							? { ok: settled.ok, error: settled.error }
							: await pullOllamaModel(target.model);
						setModelPullOutcomes((prev) => ({
							...prev,
							[BUILD_MODEL_SETTING_KEY]: {
								model: target.model,
								ok: pullResult.ok,
								error: pullResult.error,
							},
						}));
						if (!pullResult.ok) return; // the modelPullFailure banner surfaces the reason
					}
				}
			}
			const body: Record<string, string> = {};
			for (const key of changedKeys) {
				body[key] = edited[key] ?? "";
			}
			const result = await updateRepoSettings(owner, repo, body);
			setPendingRestart(result.requiresRestart.length > 0);
			setEdited({});
			setChangedKeys(new Set());
			setBuildModelProviderEdit(null);
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [changedKeys, edited, buildModelProviderDefault, modelPullOutcomes, load, owner, repo]);

	const handleRemove = useCallback(async () => {
		if (!window.confirm(`Are you sure you want to remove ${owner}/${repo}?`)) {
			return;
		}
		setRemoving(true);
		setError(null);
		try {
			await removeRepo(owner, repo);
			navigate({ screen: "repos" });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setRemoving(false);
		}
	}, [owner, repo]);

	const empty = useMemo(() => settings.length === 0 && !loading, [settings.length, loading]);

	// Blocking model error: a pending build-model override with a settled
	// failed pull. Derived from the per-key outcomes (not transient state) so
	// the save/refresh cycle cannot wipe it while it is still relevant.
	const modelPullFailure = (() => {
		if (!changedKeys.has(BUILD_MODEL_SETTING_KEY)) return null;
		const pending = String(edited[BUILD_MODEL_SETTING_KEY] ?? "").trim();
		if (pending === "") return null;
		const target = parseRepoBuildModelOverride(pending);
		if ((target.provider || buildModelProviderDefault) !== "ollama") return null;
		const outcome = modelPullOutcomes[BUILD_MODEL_SETTING_KEY];
		if (outcome && !outcome.ok && outcome.model === target.model) {
			return describePullFailure(target.model, outcome.error);
		}
		return null;
	})();

	return (
		<RepoScopedScreenShell
			owner={owner}
			repo={repo}
			activeTab="settings"
			onSelectTab={onSelectTab}
			onBack={onBack}
			loading={loading}
			loadingMessage="Loading settings..."
			empty={empty}
			emptyMessage="No settings available for this repository."
		>
			<div className="detail-pane">
				<h2>Repository Settings</h2>
				<p className="setting-description">Override the global defaults for this repository only.</p>
				{pendingRestart ? <RestartBanner>A restart is required for repository event-mode or worker-template changes to take effect.</RestartBanner> : null}
				{error ? <div className="error-banner">{error}</div> : null}
				{modelPullFailure ? <div className="error-banner" role="alert">{modelPullFailure}</div> : null}
				<div className="settings-list">
					{settings.map((setting) => {
						const displayValue = changedKeys.has(setting.key) ? (edited[setting.key] ?? "") : (setting.override ?? "");
						return (
							<div key={setting.key} className={`setting-row${changedKeys.has(setting.key) ? " dirty" : ""}`}>
								<label htmlFor={`repo-setting-${setting.key}`}>
									<span className="setting-key">{setting.key}</span>
									{setting.requiresRestart ? <span className="restart-badge">restart</span> : null}
								</label>
								<p className="setting-description">{setting.description}</p>
								{setting.key === BUILD_MODEL_SETTING_KEY ? (
									<BuildModelControls
										setting={setting}
										composedValue={displayValue}
										providerDefault={buildModelProviderDefault}
										providerEdit={buildModelProviderEdit}
										onProviderEdit={setBuildModelProviderEdit}
										onChange={(value) => handleChange(setting.key, value)}
										onPullResult={handleBuildModelPullResult}
									/>
								) : setting.options ? (
									<select
										id={`repo-setting-${setting.key}`}
										value={displayValue}
										onChange={(event) => handleChange(setting.key, event.target.value)}
									>
										<option value="">Use global default ({setting.default})</option>
										{setting.options.map((option) => (
											<option key={option} value={option}>
												{setting.optionLabels?.[option] ?? option}
											</option>
										))}
									</select>
								) : (
									<input
										id={`repo-setting-${setting.key}`}
										type="text"
										value={displayValue}
										placeholder={`Use global default (${setting.default})`}
										onChange={(event) => handleChange(setting.key, event.target.value)}
									/>
								)}
								<span className="setting-default">
									Effective: {setting.value} {setting.inherited ? "(global)" : "(override)"}
								</span>
							</div>
						);
					})}
				</div>
				<div className="settings-actions">
					<button
						className="action-btn restart"
						type="button"
						onClick={() => {
							void handleSave();
						}}
						disabled={saving || changedKeys.size === 0}
					>
						{saving ? "Saving..." : "Save Changes"}
					</button>
				</div>
				<div className="settings-actions danger-zone">
					<button
						className="action-btn delete"
						type="button"
						onClick={() => {
							void handleRemove();
						}}
						disabled={removing}
					>
						{removing ? "Removing..." : "Remove Repository"}
					</button>
				</div>
			</div>
		</RepoScopedScreenShell>
	);
}

function BuildModelControls({
	setting,
	composedValue,
	providerDefault,
	providerEdit,
	onProviderEdit,
	onChange,
	onPullResult,
}: {
	setting: RepoSettingView;
	/** The composed (persisted) override value: a bare id, provider/model, or empty to inherit. */
	composedValue: string;
	providerDefault: string;
	/**
	 * Explicit provider pick that is not yet representable in the composed
	 * value (picked while no model is selected); null derives from the value.
	 */
	providerEdit: string | null;
	onProviderEdit: (provider: string) => void;
	onChange: (value: string) => void;
	onPullResult: (outcome: LlmModelPullUpdate) => void;
}): React.ReactElement {
	const parsed = useMemo(() => parseRepoBuildModelOverride(composedValue), [composedValue]);
	// The stored provider/model slash form carries an explicit provider; a
	// bare model id (or an empty inherit value) only implies one once a model
	// is selected, so a fresh provider pick is tracked separately.
	const provider = parsed.model !== "" ? parsed.provider : (providerEdit ?? parsed.provider);
	// The model list and Ollama pull validation run against the override's
	// own provider when one is selected, else the global provider.
	const effectiveProvider = provider || providerDefault;

	return (
		<div className="build-model-controls">
			<div className="build-model-provider">
				<label htmlFor={`repo-setting-${setting.key}-provider`}>Provider</label>
				<select
					id={`repo-setting-${setting.key}-provider`}
					value={provider}
					onChange={(event) => {
						onProviderEdit(event.target.value);
						onChange(composeRepoBuildModelOverride(event.target.value, parsed.model));
					}}
				>
					<option value="">Use global default ({providerDefault})</option>
					{BUILD_MODEL_PROVIDERS.map((provider) => (
						<option key={provider} value={provider}>{provider}</option>
					))}
				</select>
			</div>
			<LlmModelSelect
				provider={effectiveProvider}
				value={parsed.model}
				onChange={(model) => onChange(composeRepoBuildModelOverride(provider, model))}
				fetcher={llmModelFetcher}
				puller={effectiveProvider === "ollama" ? pullOllamaModel : undefined}
				onPullResult={effectiveProvider === "ollama" ? onPullResult : undefined}
				id={`repo-setting-${setting.key}`}
				label={setting.key}
				hideLabel
				emptyOptionLabel={
					setting.default ? `Use global default (${setting.default})` : "Use global default"
				}
			/>
		</div>
	);
}
