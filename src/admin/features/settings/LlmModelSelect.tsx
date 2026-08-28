import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LlmModelListResult } from "../../api/settings.js";

export const PRIVATE_MODEL_VALUE = "private";

export type LlmModelFetcher = (
	provider: "openai" | "ollama",
	apiKey?: string,
) => Promise<LlmModelListResult>;

export type LlmModelPullResult = { ok: boolean; error?: string };
export type LlmModelPuller = (model: string) => Promise<LlmModelPullResult>;

interface LlmModelSelectProps {
	provider: string;
	value: string;
	onChange: (value: string) => void;
	fetcher: LlmModelFetcher;
	puller?: LlmModelPuller;
	apiKey?: string;
	label?: string;
	id?: string;
	/** When true, omit the internal <label> so a parent can provide it. */
	hideLabel?: boolean;
	disabled?: boolean;
}

/**
 * Provider-aware model selector used by the AI / LLM settings tab and the
 * onboarding wizard. Fetches the model list from the control plane, offers a
 * `private` option for custom identifiers, and degrades to a disabled
 * placeholder when the provider prerequisite is missing.
 */
export function LlmModelSelect({
	provider,
	value,
	onChange,
	fetcher,
	puller,
	apiKey,
	label = "LLM Model",
	id = "pi_agent_model",
	hideLabel = false,
	disabled = false,
}: LlmModelSelectProps): React.ReactElement {

	const [models, setModels] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pullWarning, setPullWarning] = useState<string | null>(null);
	const [privateValue, setPrivateValue] = useState(value);
	const [privateActive, setPrivateActive] = useState(false);

	const normalizedProvider = useMemo(() => {
		const trimmed = provider.trim();
		return trimmed === "openai" || trimmed === "ollama" ? trimmed : null;
	}, [provider]);

	const pullSequence = useRef(0);
	const triggerPull = useCallback(
		(model: string) => {
			if (normalizedProvider !== "ollama" || !puller) return;
			const trimmed = model.trim();
			if (!trimmed) return;
			const sequence = ++pullSequence.current;
			void puller(trimmed)
				.then((result) => {
					if (sequence !== pullSequence.current) return;
					if (result.ok) {
						setPullWarning(null);
						return;
					}
					setPullWarning(
						`Could not pull Ollama model: ${result.error?.trim() || "unknown error"}`,
					);
				})
				.catch((err) => {
					if (sequence !== pullSequence.current) return;
					const message = err instanceof Error ? err.message : String(err);
					setPullWarning(`Could not pull Ollama model: ${message}`);
				});
		},
		[normalizedProvider, puller],
	);

	// Load the model list whenever the provider or supplied API key changes.
	useEffect(() => {
		if (!normalizedProvider) {
			setModels([]);
			setError(null);
			setLoading(false);
			return;
		}

		let cancelled = false;
		setModels([]);
		setLoading(true);
		setError(null);
		fetcher(normalizedProvider, apiKey)
			.then((result) => {
				if (cancelled) return;
				setModels(result.models);
				setError(result.error ?? null);
			})
			.catch((err) => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : String(err));
				setModels([]);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [normalizedProvider, apiKey, fetcher]);

	// Keep private mode in sync with the controlled value and loaded list,
	// but preserve a user-initiated private selection when the value itself
	// has not changed.
	const previousValue = useRef(value);
	const previousIncluded = useRef(false);
	useEffect(() => {
		const included = models.includes(value);
		const valueChanged = value !== previousValue.current;
		const includedChanged = included !== previousIncluded.current;

		if (valueChanged || includedChanged) {
			previousIncluded.current = included;
			previousValue.current = value;
			if (included) {
				setPrivateActive(false);
			} else if (value !== "") {
				setPrivateActive(true);
				setPrivateValue(value);
			} else {
				setPrivateActive(false);
			}
			return;
		}

		// Covers the initial load when `included` is false both before and after
		// the fetch completes (models change, but inclusion does not). We only
		// activate private mode after the fetch resolves so we do not flash the
		// private input while the model list is still loading.
		if (!loading && !included && value !== "" && !privateActive) {
			setPrivateActive(true);
			setPrivateValue(value);
		}
	}, [value, models, privateActive, loading]);

	const handleSelectChange = useCallback(
		(selected: string) => {
			if (selected === PRIVATE_MODEL_VALUE) {
				setPrivateActive(true);
				setPullWarning(null);
				onChange(privateValue);
				triggerPull(privateValue);
				return;
			}
			setPrivateActive(false);
			setPullWarning(null);
			onChange(selected);
		},
		[onChange, privateValue, triggerPull],
	);

	const handlePrivateChange = useCallback(
		(input: string) => {
			setPrivateValue(input);
			setPrivateActive(true);
			setPullWarning(null);
			onChange(input);
		},
		[onChange],
	);

	const selectValue = useMemo(() => {
		if (privateActive) return PRIVATE_MODEL_VALUE;
		if (models.includes(value)) return value;
		return "";
	}, [privateActive, value, models]);

	const placeholder = useMemo(() => {
		if (loading) return "Loading models...";
		if (error) return error;
		if (models.length === 0) return "No models available";
		return "Select a model…";
	}, [loading, error, models.length]);

	const showPrivateInput = privateActive;

	useEffect(() => {
		if (!privateActive && pullWarning !== null) {
			setPullWarning(null);
		}
	}, [privateActive, pullWarning]);

	return (
		<div className="llm-model-select">
			{!hideLabel && <label htmlFor={id}>{label}</label>}
			<select
				id={id}
				value={selectValue}
				onChange={(e) => handleSelectChange(e.target.value)}
				disabled={disabled || loading}
				aria-invalid={error ? "true" : undefined}
				aria-describedby={error ? `${id}-error` : undefined}
			>
				<option value="" disabled>{placeholder}</option>
				{models.map((model) => (
					<option key={model} value={model}>{model}</option>
				))}
				<option value={PRIVATE_MODEL_VALUE}>Private / custom model</option>
			</select>
			{showPrivateInput && (
				<input
					id={`${id}-private`}
					type="text"
					value={privateValue}
					onChange={(e) => handlePrivateChange(e.target.value)}
					onBlur={() => triggerPull(privateValue)}
					placeholder="custom model identifier"
					disabled={disabled}
					aria-label={`${label} (custom identifier)`}
				/>
			)}
			{pullWarning && (
				<span id={`${id}-warning`} className="setting-description" role="alert">
					{pullWarning}
				</span>
			)}
			{error && (
				<span id={`${id}-error`} className="setting-description" role="alert">
					{error}
				</span>
			)}
		</div>
	);
}
