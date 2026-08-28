import React from "react";
import { LLM_PROVIDER_OPTIONS } from "../../../../domain/onboarding/policy.js";
import { OllamaSignInPanel } from "../../settings/OllamaSignInPanel.js";
import { LlmModelSelect } from "../../settings/LlmModelSelect.js";
import {
	fetchOnboardingLlmModels,
	fetchOnboardingOllamaSignInStatus,
	pullOnboardingOllamaModel,
} from "../../../api/onboarding.js";
import { DEFAULT_OLLAMA_CONTAINER_NAME } from "../wizard-state.js";
import type { UpdateField, WizardState } from "../wizard-state.js";

export interface StepFourAiLlmProps {
	state: WizardState;
	updateField: UpdateField;
}

export function StepFourAiLlm({
	state,
	updateField,
}: StepFourAiLlmProps): React.ReactElement {
	const provider = state.piAgentProvider.trim();
	const isOllama = provider === "ollama";
	const isOpenAi = provider === "openai";
	return (
		<div className="onboarding-form">
			<div className="form-group">
				<label htmlFor="pi_agent_provider">LLM Provider</label>
				<select
					id="pi_agent_provider"
					value={state.piAgentProvider}
					onChange={(e) => updateField("piAgentProvider", e.target.value)}
				>
					{LLM_PROVIDER_OPTIONS.map((option) => (
						<option key={option} value={option}>{option}</option>
					))}
				</select>
				<span className="setting-description">
					Select the LLM provider worker containers use. Ollama runs locally;
					openai uses an OpenAI platform API key.
				</span>
			</div>

			{isOllama && (
				<>
					<div className="form-group">
						<label htmlFor="ollama_container_name">Ollama Container Name</label>
						<input
							id="ollama_container_name"
							type="text"
							value={state.ollamaContainerName}
							onChange={(e) => updateField("ollamaContainerName", e.target.value)}
							placeholder={DEFAULT_OLLAMA_CONTAINER_NAME}
							required
						/>
						<span className="setting-description">
							Name of the Ollama Docker container the control plane shells into to
							check sign-in status. Defaults to yolomatic-ollama.
						</span>
					</div>

					<OllamaSignInPanel
						containerName={state.ollamaContainerName}
						fetchStatus={fetchOnboardingOllamaSignInStatus}
					/>
				</>
			)}

			{isOpenAi && (
				<div className="form-group">
					<label htmlFor="openai_api_key">OpenAI API Key</label>
					<input
						id="openai_api_key"
						type="password"
						value={state.openaiApiKey}
						onChange={(e) => {
							updateField("openaiApiKey", e.target.value);
							if (state.openaiApiKeyProtected) updateField("openaiApiKeyProtected", false);
						}}
						placeholder={state.openaiApiKeyProtected ? "Leave unchanged (configured)" : "sk-..."}
						required
					/>
					<span className="setting-description">
						{state.openaiApiKeyProtected
							? "An OpenAI API key is already configured. Leave the field blank to keep it, or enter a new one to replace it."
							: "OpenAI platform API key. Required for the openai provider; forwarded to worker containers as OPENAI_API_KEY."}
					</span>
				</div>
			)}

			<div className="form-group">
				<LlmModelSelect
					provider={state.piAgentProvider}
					value={state.piAgentModel}
					onChange={(val) => updateField("piAgentModel", val)}
					fetcher={fetchOnboardingLlmModels}
					puller={isOllama ? pullOnboardingOllamaModel : undefined}
					apiKey={isOpenAi ? state.openaiApiKey.trim() : undefined}
					id="pi_agent_model"
					label="LLM Model"
				/>
				<span className="setting-description">
					The model identifier worker containers use when invoking the LLM. This
					matches the free-text field on Settings → AI / LLM.
				</span>
			</div>
		</div>
	);
}