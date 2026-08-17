/**
 * Onboarding wizard submission mapping.
 *
 * Translates the in-progress wizard state into the exact `Record<string,
 * string>` payload submitted to `POST /api/onboarding`. The payload shape is
 * a stable HTTP contract shared with the server route; this module is the
 * single place that constructs it.
 */
import {
	isPollingMode,
	isWebhookMode,
	parsePollIntervalMs,
} from "../../../domain/onboarding/policy.js";
import type { WizardState } from "./wizard-state.js";

/**
 * The subset of {@link WizardState} used to build the submission payload.
 * Repository selection, the current step, and the transient error banner are
 * intentionally excluded — they do not appear in the onboarding body.
 */
export type WizardSubmissionState = Pick<
	WizardState,
	| "adminFullName"
	| "adminUsername"
	| "adminPassword"
	| "githubToken"
	| "githubUsername"
	| "githubEventMode"
	| "githubPollIntervalMs"
	| "webhookSecret"
	| "piAgentProvider"
	| "piAgentModel"
	| "ollamaContainerName"
	| "openaiApiKey"
>;

/**
 * Builds the onboarding submission payload for the given wizard state.
 * Protected secrets are submitted as empty strings so the backend preserves
 * the previously configured value; the webhook secret is included only when
 * webhook delivery is enabled; the polling interval is included (normalized
 * to its trimmed integer string) only when polling is enabled and valid.
 */
export function buildOnboardingBody(state: WizardSubmissionState): Record<string, string> {
	const onboardingBody: Record<string, string> = {
		github_token: state.githubToken.trim(),
		github_username: state.githubUsername.trim(),
		admin_full_name: state.adminFullName.trim(),
		admin_username: state.adminUsername.trim(),
		admin_password: state.adminPassword.trim(),
		github_event_mode: state.githubEventMode,
	};
	if (isWebhookMode(state.githubEventMode)) {
		onboardingBody.webhook_secret = state.webhookSecret.trim();
	}
	if (isPollingMode(state.githubEventMode)) {
		const interval = parsePollIntervalMs(state.githubPollIntervalMs);
		if (interval !== null) {
			onboardingBody.github_poll_interval_ms = String(interval);
		}
	}
	onboardingBody.pi_agent_provider = state.piAgentProvider.trim();
	onboardingBody.pi_agent_model = state.piAgentModel.trim();
	onboardingBody.ollama_container_name = state.ollamaContainerName.trim();
	onboardingBody.openai_api_key = state.openaiApiKey.trim();
	return onboardingBody;
}