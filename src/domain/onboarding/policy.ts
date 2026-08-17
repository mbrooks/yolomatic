/**
 * Shared onboarding policy for browser and server code.
 *
 * This module is the single source of truth for the GitHub event-delivery
 * modes, polling-interval rules, and LLM provider values that both the
 * onboarding wizard (browser) and the onboarding HTTP routes (server) depend
 * on. It must remain free of any DOM or Node-specific imports so both runtimes
 * can import it without pulling in environment-specific globals.
 */

/** Supported GitHub event-delivery modes for onboarding defaults. */
export type GithubEventMode = "webhook" | "polling" | "both";

/**
 * Event modes offered by the wizard, in display order.
 * `VALID_EVENT_MODES` is a string-typed alias for server-side validation that
 * intentionally matches the same array reference.
 */
export const EVENT_MODE_OPTIONS: readonly GithubEventMode[] = ["webhook", "polling", "both"];
export const VALID_EVENT_MODES: readonly string[] = EVENT_MODE_OPTIONS;

/** LLM provider values accepted by the onboarding submission handler. */
export const LLM_PROVIDER_OPTIONS: readonly string[] = ["ollama", "openai"];
export const VALID_ONBOARDING_PROVIDERS: readonly string[] = LLM_PROVIDER_OPTIONS;

/** Minimum accepted GitHub polling interval, in milliseconds. */
export const MIN_POLL_INTERVAL_MS = 1000;

/** Default GitHub polling interval prefilled when a polling mode is selected. */
export const DEFAULT_POLL_INTERVAL_MS = 60000;

/** Returns true when the mode enables polling-based event discovery. */
export function isPollingMode(mode: string | undefined): boolean {
	return mode === "polling" || mode === "both";
}

/** Returns true when the mode enables webhook-based event delivery. */
export function isWebhookMode(mode: string | undefined): boolean {
	return mode === "webhook" || mode === "both";
}

/** Returns true when the mode is one of the supported event-delivery modes. */
export function isValidEventMode(mode: string | undefined): boolean {
	return typeof mode === "string" && VALID_EVENT_MODES.includes(mode);
}

/**
 * Parses a polling interval string into a positive integer of at least
 * {@link MIN_POLL_INTERVAL_MS}, or returns `null` when the value is empty,
 * non-numeric, or below the minimum.
 */
export function parsePollIntervalMs(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const trimmed = raw.trim();
	if (!/^[0-9]+$/.test(trimmed)) {
		return null;
	}
	const value = Number.parseInt(trimmed, 10);
	if (!Number.isInteger(value) || value < MIN_POLL_INTERVAL_MS) {
		return null;
	}
	return value;
}

/** Returns true when `raw` parses into a valid polling interval. */
export function isValidPollIntervalMs(raw: string | undefined): boolean {
	return parsePollIntervalMs(raw) !== null;
}