/**
 * Onboarding wizard step validation.
 *
 * Pure predicates extracted from `OnboardingWizard.tsx`. They encode the
 * per-step gating rules (event-mode requirements, AI / LLM field requirements)
 * and depend only on the shared onboarding policy.
 */
import {
	isValidEventMode,
	isPollingMode,
	isWebhookMode,
	parsePollIntervalMs,
} from "../../../domain/onboarding/policy.js";
import type { PiAgentModelPullOutcome } from "./wizard-state.js";

/**
 * Validates the GitHub event-mode wizard step.
 * - The mode must be one of the supported event modes.
 * - When polling is enabled, the polling interval must parse to a valid value.
 * - When webhook delivery is enabled, a webhook secret must be present unless a
 *   protected secret is already configured.
 */
export function isEventModeStepValid(
	mode: string,
	pollInterval: string,
	webhookSecret: string,
	webhookSecretProtected = false,
): boolean {
	if (!isValidEventMode(mode)) {
		return false;
	}
	if (isPollingMode(mode) && parsePollIntervalMs(pollInterval) === null) {
		return false;
	}
	if (isWebhookMode(mode) && !webhookSecretProtected && webhookSecret.trim().length === 0) {
		return false;
	}
	return true;
}

/**
 * Validates the AI / LLM wizard step. A provider must be selected; when the
 * provider is `ollama` the container name must be non-empty. A model is
 * required for every provider. Ollama sign-in status is informational only and
 * never gates advancing.
 */
export function isAiLlmStepValid(
	provider: string,
	model: string,
	containerName: string,
): boolean {
	const providerTrimmed = provider.trim();
	if (!providerTrimmed) {
		return false;
	}
	if (providerTrimmed === "ollama") {
		if (containerName.trim().length === 0) {
			return false;
		}
	}
	if (model.trim().length === 0) {
		return false;
	}
	return true;
}

/**
 * Determines whether advancing past the AI / LLM step is blocked because the
 * most recent settled Ollama pull for the wizard's current model identifier
 * failed. Only applies to the `ollama` provider (no puller is wired for
 * `openai`) and only while the failed identifier is still the one being
 * committed; editing the model supersedes the stale failure until the next
 * pull settles.
 */
export function isAiLlmPullBlocked(
	provider: string,
	model: string,
	outcome: PiAgentModelPullOutcome | null,
): boolean {
	if (!outcome || outcome.ok) {
		return false;
	}
	return provider.trim() === "ollama" && outcome.model === model.trim();
}
