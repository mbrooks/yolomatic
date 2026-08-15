import { describe, expect, it } from "vitest";

import {
	DEFAULT_LOGGING_SETTINGS,
	EMPTY_MODEL_SETTINGS,
	getRuntimeSettings,
	loggingSettingsFromEnv,
	modelSettingsFromEnv,
	resolveRuntimeSettings,
	runtimeSettingsFromEnv,
	type LoggingSettings,
	type ModelSettings,
	type RuntimeSettings,
} from "./runtime-settings.js";
import type { AppConfig } from "./config.js";

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
	return {
		port: 6767,
		webhookSecret: "secret",
		sessionsDir: "/tmp/sessions",
		archiveDir: "/tmp/archive",
		defaultBranch: "main",
		githubToken: "tok",
		githubUsername: "bot",
		workspacesDir: "/tmp/workspaces",
		soulPath: "/tmp/SOUL.md",
		selfReportEnabled: true,
		onboardingComplete: true,
		adminGithubUsername: undefined,
		memoryDir: "/tmp/memory",
		cleanupRetentionDays: undefined,
		staleThresholdMs: 14400000,
		maxWorktrees: 10,
		evictionStrategy: "lru",
		piAgentModel: undefined,
		piAgentProvider: undefined,
		logLevel: "info",
		logPrompts: true,
		logThoughts: true,
		logTools: true,
		logResponses: true,
		githubEventMode: "webhook",
		githubPollIntervalMs: 60000,
		workerWorkspaceMountSource: "/tmp/workspaces",
		workerControlBaseUrl: "http://host.docker.internal:6767",
		workerOllamaHost: undefined,
		openaiApiKey: "",
		adminPath: "/yolomatic/admin",
		adminDefaultPage: "#/dashboard",
		issueNewCommentEnabled: true,
		issueAdminLinkInCommentsEnabled: true,
		adminBaseUrl: undefined,
		...overrides,
	} as AppConfig;
}

describe("DEFAULT_LOGGING_SETTINGS", () => {
	it("matches the legacy process.env defaults (info level, all flags enabled)", () => {
		expect(DEFAULT_LOGGING_SETTINGS).toEqual({
			logLevel: "info",
			logPrompts: true,
			logThoughts: true,
			logTools: true,
			logResponses: true,
		});
	});
});

describe("getRuntimeSettings", () => {
	it("maps AppConfig model and logging fields into runtime settings", () => {
		const config = baseConfig({
			piAgentModel: "kimi",
			piAgentProvider: "ollama",
			openaiApiKey: "sk-test",
			workerOllamaHost: "http://ollama.internal:11434",
			logLevel: "debug",
			logPrompts: false,
			logThoughts: false,
			logTools: false,
			logResponses: false,
		});

		expect(getRuntimeSettings(config)).toEqual({
			model: {
				piAgentModel: "kimi",
				piAgentProvider: "ollama",
				openaiApiKey: "sk-test",
				ollamaHost: "http://ollama.internal:11434",
			},
			logging: {
				logLevel: "debug",
				logPrompts: false,
				logThoughts: false,
				logTools: false,
				logResponses: false,
			},
		});
	});

	it("normalizes an empty openaiApiKey to undefined", () => {
		const settings = getRuntimeSettings(baseConfig({ openaiApiKey: "" }));
		expect(settings.model.openaiApiKey).toBeUndefined();
	});

	it("carries undefined for unset model fields", () => {
		const settings = getRuntimeSettings(baseConfig());
		expect(settings.model).toEqual({
			piAgentModel: undefined,
			piAgentProvider: undefined,
			openaiApiKey: undefined,
			ollamaHost: undefined,
		});
	});
});

describe("loggingSettingsFromEnv", () => {
	it("returns the default settings when no LOG_* env vars are present", () => {
		expect(loggingSettingsFromEnv({})).toEqual(DEFAULT_LOGGING_SETTINGS);
	});

	it("lowercases and trims LOG_LEVEL, falling back to info", () => {
		expect(loggingSettingsFromEnv({ LOG_LEVEL: "  ERROR  " }).logLevel).toBe("error");
		expect(loggingSettingsFromEnv({ LOG_LEVEL: "" }).logLevel).toBe("info");
		expect(loggingSettingsFromEnv({}).logLevel).toBe("info");
	});

	it("treats only the exact string 'false' as disabled (legacy semantics)", () => {
		expect(loggingSettingsFromEnv({ LOG_PROMPTS: "false" }).logPrompts).toBe(false);
		expect(loggingSettingsFromEnv({ LOG_PROMPTS: "true" }).logPrompts).toBe(true);
		expect(loggingSettingsFromEnv({ LOG_PROMPTS: "" }).logPrompts).toBe(true);
		expect(loggingSettingsFromEnv({ LOG_PROMPTS: undefined }).logPrompts).toBe(true);

		expect(loggingSettingsFromEnv({ LOG_THOUGHTS: "false" }).logThoughts).toBe(false);
		expect(loggingSettingsFromEnv({ LOG_TOOLS: "false" }).logTools).toBe(false);
		expect(loggingSettingsFromEnv({ LOG_RESPONSES: "false" }).logResponses).toBe(false);
	});
});

describe("modelSettingsFromEnv", () => {
	it("trims and reads PI_AGENT_* and credential env vars", () => {
		expect(modelSettingsFromEnv({
			PI_AGENT_MODEL: "  glm  ",
			PI_AGENT_PROVIDER: " ollama ",
			OPENAI_API_KEY: "  sk-from-env  ",
			OLLAMA_HOST: "  http://ollama:11434  ",
		})).toEqual({
			piAgentModel: "glm",
			piAgentProvider: "ollama",
			openaiApiKey: "sk-from-env",
			ollamaHost: "http://ollama:11434",
		});
	});

	it("normalizes blank values to undefined", () => {
		expect(modelSettingsFromEnv({
			PI_AGENT_MODEL: "   ",
			PI_AGENT_PROVIDER: "",
			OPENAI_API_KEY: "  ",
			OLLAMA_HOST: "",
		})).toEqual({
			piAgentModel: undefined,
			piAgentProvider: undefined,
			openaiApiKey: undefined,
			ollamaHost: undefined,
		});
	});
});

describe("runtimeSettingsFromEnv", () => {
	it("combines model and logging env-derived settings", () => {
		const settings = runtimeSettingsFromEnv({
			PI_AGENT_MODEL: "kimi",
			PI_AGENT_PROVIDER: "ollama",
			OPENAI_API_KEY: "sk-test",
			OLLAMA_HOST: "http://ollama:11434",
			LOG_LEVEL: "warn",
			LOG_PROMPTS: "false",
		});

		expect(settings).toEqual({
			model: {
				piAgentModel: "kimi",
				piAgentProvider: "ollama",
				openaiApiKey: "sk-test",
				ollamaHost: "http://ollama:11434",
			},
			logging: {
				logLevel: "warn",
				logPrompts: false,
				logThoughts: true,
				logTools: true,
				logResponses: true,
			},
		});
	});
});

describe("resolveRuntimeSettings", () => {
	it("returns default settings when no provider is given", () => {
		expect(resolveRuntimeSettings(undefined)).toEqual({
			model: EMPTY_MODEL_SETTINGS,
			logging: DEFAULT_LOGGING_SETTINGS,
		});
	});

	it("returns a static RuntimeSettings object as-is", () => {
		const settings: RuntimeSettings = {
			model: { piAgentModel: "kimi" },
			logging: { ...DEFAULT_LOGGING_SETTINGS, logLevel: "debug" },
		};
		expect(resolveRuntimeSettings(settings)).toBe(settings);
	});

	it("invokes a function provider", () => {
		const settings: RuntimeSettings = {
			model: { piAgentModel: "glm" },
			logging: DEFAULT_LOGGING_SETTINGS,
		};
		const provider = () => settings;
		expect(resolveRuntimeSettings(provider)).toBe(settings);
	});

	it("invokes get() on an object provider", () => {
		let calls = 0;
		const settings: RuntimeSettings = {
			model: { piAgentModel: "gpt-5.2" },
			logging: DEFAULT_LOGGING_SETTINGS,
		};
		const provider = {
			get() {
				calls += 1;
				return settings;
			},
		};
		expect(resolveRuntimeSettings(provider)).toBe(settings);
		expect(calls).toBe(1);
	});

	it("two function providers can return different settings without touching process.env", () => {
		const originalModel = process.env.PI_AGENT_MODEL;
		const originalLevel = process.env.LOG_LEVEL;
		try {
			const a: () => RuntimeSettings = () => ({
				model: { piAgentModel: "kimi" },
				logging: { ...DEFAULT_LOGGING_SETTINGS, logLevel: "info" },
			});
			const b: () => RuntimeSettings = () => ({
				model: { piAgentModel: "glm" },
				logging: { ...DEFAULT_LOGGING_SETTINGS, logLevel: "error" },
			});

			expect(resolveRuntimeSettings(a).model.piAgentModel).toBe("kimi");
			expect(resolveRuntimeSettings(b).model.piAgentModel).toBe("glm");
			expect(resolveRuntimeSettings(a).logging.logLevel).toBe("info");
			expect(resolveRuntimeSettings(b).logging.logLevel).toBe("error");
			// process.env must be untouched by resolving injected settings.
			expect(process.env.PI_AGENT_MODEL).toBe(originalModel);
			expect(process.env.LOG_LEVEL).toBe(originalLevel);
		} finally {
			if (originalModel === undefined) delete process.env.PI_AGENT_MODEL;
			else process.env.PI_AGENT_MODEL = originalModel;
			if (originalLevel === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = originalLevel;
		}
	});

	it("a function provider reflects updates between calls (live reconfiguration)", () => {
		let current: ModelSettings = { piAgentModel: "kimi" };
		const provider = (): RuntimeSettings => ({
			model: current,
			logging: DEFAULT_LOGGING_SETTINGS,
		});
		expect(resolveRuntimeSettings(provider).model.piAgentModel).toBe("kimi");
		current = { piAgentModel: "glm" };
		expect(resolveRuntimeSettings(provider).model.piAgentModel).toBe("glm");
	});
});

// Type-only compile checks: the exported shapes are stable contracts.
describe("type exports", () => {
	it("exposes ModelSettings, LoggingSettings, and RuntimeSettings types", () => {
		const model: ModelSettings = { piAgentModel: "kimi" };
		const logging: LoggingSettings = DEFAULT_LOGGING_SETTINGS;
		const runtime: RuntimeSettings = { model, logging };
		expect(runtime.model).toBe(model);
		expect(runtime.logging).toBe(logging);
	});
});