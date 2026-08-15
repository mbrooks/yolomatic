import type { AppConfig } from "./config.js";

/**
 * Runtime model settings: the provider/model and credential values that
 * previously lived in `process.env` (PI_AGENT_MODEL, PI_AGENT_PROVIDER,
 * OPENAI_API_KEY) plus the Ollama host used to reach the local Ollama daemon.
 *
 * These are the "migrated" model keys. They are read from the configuration
 * boundary (env ingestion in `getConfig()` / worker startup) and injected
 * into the runtime components that consume them.
 */
export interface ModelSettings {
	piAgentModel?: string;
	piAgentProvider?: string;
	openaiApiKey?: string;
	ollamaHost?: string;
}

/**
 * Runtime logging settings: the level and category flags that previously lived
 * in `process.env` (LOG_LEVEL, LOG_PROMPTS, LOG_THOUGHTS, LOG_TOOLS,
 * LOG_RESPONSES).
 */
export interface LoggingSettings {
	logLevel: string;
	logPrompts: boolean;
	logThoughts: boolean;
	logTools: boolean;
	logResponses: boolean;
}

/**
 * Aggregate runtime settings snapshot derived from configuration.
 */
export interface RuntimeSettings {
	model: ModelSettings;
	logging: LoggingSettings;
}

/**
 * A runtime settings provider returns a fresh snapshot on demand. Components
 * read from the provider at execution time so live database-setting updates
 * affect the next execution without mutating global state.
 *
 * A bare `RuntimeSettings` object or a `() => RuntimeSettings` function are
 * also accepted by {@link resolveRuntimeSettings}; both are treated as
 * providers.
 */
export interface RuntimeSettingsProvider {
	get(): RuntimeSettings;
}

/**
 * Default logging settings, matching the legacy `process.env` defaults:
 * level `info` with every category enabled. Operators disable a category by
 * setting the corresponding flag to `false` in the injected settings.
 */
export const DEFAULT_LOGGING_SETTINGS: LoggingSettings = {
	logLevel: "info",
	logPrompts: true,
	logThoughts: true,
	logTools: true,
	logResponses: true,
};

/**
 * Empty model settings: nothing configured, so consumers fall back to their
 * built-in defaults (e.g. Pi's default model resolution).
 */
export const EMPTY_MODEL_SETTINGS: ModelSettings = {};

/**
 * Derive runtime settings from a loaded {@link AppConfig}. `getConfig()`
 * remains the single place that ingests environment variables and database
 * settings; this maps its fields into the runtime contract consumed by
 * executors and loggers.
 */
export function getRuntimeSettings(config: AppConfig): RuntimeSettings {
	return {
		model: {
			piAgentModel: config.piAgentModel,
			piAgentProvider: config.piAgentProvider,
			openaiApiKey: config.openaiApiKey || undefined,
			ollamaHost: config.workerOllamaHost,
		},
		logging: {
			logLevel: config.logLevel,
			logPrompts: config.logPrompts,
			logThoughts: config.logThoughts,
			logTools: config.logTools,
			logResponses: config.logResponses,
		},
	};
}

/**
 * Read logging settings from a process environment. This is a configuration
 * boundary helper (used by the worker, whose process environment is its
 * configuration input) and preserves the legacy `process.env` defaulting
 * semantics: `LOG_LEVEL` defaults to `info`, and each `LOG_*` flag is disabled
 * only when set to the exact string `"false"`.
 */
export function loggingSettingsFromEnv(env: NodeJS.ProcessEnv): LoggingSettings {
	return {
		logLevel: env.LOG_LEVEL?.trim().toLowerCase() || "info",
		logPrompts: env.LOG_PROMPTS !== "false",
		logThoughts: env.LOG_THOUGHTS !== "false",
		logTools: env.LOG_TOOLS !== "false",
		logResponses: env.LOG_RESPONSES !== "false",
	};
}

/**
 * Read model settings from a process environment, trimming each value and
 * normalizing blanks to `undefined`. Configuration boundary helper used by
 * the worker runtime.
 */
export function modelSettingsFromEnv(env: NodeJS.ProcessEnv): ModelSettings {
	return {
		piAgentModel: env.PI_AGENT_MODEL?.trim() || undefined,
		piAgentProvider: env.PI_AGENT_PROVIDER?.trim() || undefined,
		openaiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
		ollamaHost: env.OLLAMA_HOST?.trim() || undefined,
	};
}

/**
 * Read a full {@link RuntimeSettings} snapshot from a process environment.
 * Configuration boundary helper used by the worker runtime.
 */
export function runtimeSettingsFromEnv(env: NodeJS.ProcessEnv): RuntimeSettings {
	return {
		model: modelSettingsFromEnv(env),
		logging: loggingSettingsFromEnv(env),
	};
}

/**
 * Resolve a runtime settings input that may be `undefined`, a static
 * {@link RuntimeSettings} object, a `() => RuntimeSettings` function, or a
 * {@link RuntimeSettingsProvider}. Returns default settings when no input is
 * supplied so optional injection preserves legacy default behavior.
 */
export function resolveRuntimeSettings(
	input: RuntimeSettings | RuntimeSettingsProvider | (() => RuntimeSettings) | undefined,
): RuntimeSettings {
	if (!input) {
		return { model: { ...EMPTY_MODEL_SETTINGS }, logging: { ...DEFAULT_LOGGING_SETTINGS } };
	}
	if (typeof input === "function") {
		return (input as () => RuntimeSettings)();
	}
	if (typeof input === "object" && input !== null && typeof (input as RuntimeSettingsProvider).get === "function") {
		return (input as RuntimeSettingsProvider).get();
	}
	return input as RuntimeSettings;
}