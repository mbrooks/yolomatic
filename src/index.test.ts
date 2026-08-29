import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	createOnboardingCompleteHandler,
	defaultConfigureLogging,
	defaultStartupStateFactory,
	logLegacyStateAudit,
	main,
	shouldEnterOnboarding,
	type OnboardingCompleteHandlerDeps,
	type StartupState,
} from "./index.js";
import { noOpHandlers } from "./app/bootstrap.js";
import type { AppConfig } from "./config.js";
import type { RuntimeDeps, RuntimeGraph } from "./app/bootstrap.js";

const baseConfig: AppConfig = {
	port: 6767,
	webhookSecret: "secret",
	sessionsDir: "/tmp/sessions",
	archiveDir: "/tmp/sessions/archive",
	memoryDir: "/tmp/memory",
	defaultBranch: "main",
	githubToken: "token",
	githubUsername: "yolomatic-bot",
	workspacesDir: "/tmp/workspaces",
	soulPath: "/tmp/SOUL.md",
	selfReportEnabled: true,
	onboardingComplete: true,
	adminGithubUsername: "admin",
	cleanupRetentionDays: undefined,
	staleThresholdMs: 14400000,
	idleWorkingFailMs: 3600000,
	maxWorktrees: 10,
	evictionStrategy: "lru",
	piAgentModel: undefined,
	piAgentBuildModel: undefined,
	piAgentRefinementModel: undefined,
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
	openaiApiKey: "",
	adminPath: "/yolomatic/admin",
	adminDefaultPage: "#/dashboard",
	issueNewCommentEnabled: true,
	issueAdminLinkInCommentsEnabled: true,
	adminBaseUrl: undefined,
};

function makeFakeStores(overrides: Partial<StartupState> = {}): StartupState {
	return {
		settingsStore: {
			get: vi.fn(() => undefined),
			seedFromEnv: vi.fn(),
			applyDefaults: vi.fn(),
			onChange: vi.fn(() => () => {}),
		} as never,
		sessionStore: {
			auditLegacyState: vi.fn(async () => ({
				legacyStateFiles: [],
				sessionsMissingKind: [],
				malformedStateFiles: [],
				clean: true,
			})),
		} as never,
		repositoryStore: {} as never,
		userStore: {
			hasAnySync: vi.fn(() => true),
		} as never,
		taskController: {} as never,
		config: baseConfig,
		...overrides,
	};
}

function makeFakeServer() {
	return {
		listen: vi.fn((_port: number, cb?: () => void) => {
			if (typeof cb === "function") cb();
			return undefined;
		}),
		close: vi.fn((cb?: (err?: Error) => void) => {
			if (typeof cb === "function") cb();
			return undefined;
		}),
	};
}

function captureServer() {
	const options: Record<string, unknown>[] = [];
	const instances: ReturnType<typeof makeFakeServer>[] = [];
	const createWebhookServer = vi.fn((opts: Record<string, unknown>) => {
		options.push(opts);
		const server = makeFakeServer();
		instances.push(server);
		return server;
	}) as never;
	return { createWebhookServer, options, instances };
}

describe("default startup collaborators", () => {
	it("defaultStartupStateFactory constructs shared stores and loads config from a memory dir", async () => {
		const memoryDir = await mkdtemp(join(tmpdir(), "yolomatic-index-startup-"));
		try {
			const state = defaultStartupStateFactory(memoryDir);
			expect(state.settingsStore).toBeDefined();
			expect(state.sessionStore).toBeDefined();
			expect(state.repositoryStore).toBeDefined();
			expect(state.userStore).toBeDefined();
			expect(state.taskController).toBeDefined();
			expect(state.config.port).toBe(6767);
			expect(state.config.defaultBranch).toBe("main");
		} finally {
			await rm(memoryDir, { recursive: true, force: true });
		}
	});

	it("defaultConfigureLogging wires session log persistence without throwing", async () => {
		const memoryDir = await mkdtemp(join(tmpdir(), "yolomatic-index-logging-"));
		try {
			expect(() => defaultConfigureLogging(memoryDir)).not.toThrow();
		} finally {
			await rm(memoryDir, { recursive: true, force: true });
		}
	});
});

describe("shouldEnterOnboarding", () => {
	it("enters onboarding when bootstrap is incomplete", () => {
		expect(shouldEnterOnboarding(false, true)).toBe(true);
	});

	it("enters onboarding when no admin user exists", () => {
		expect(shouldEnterOnboarding(true, false)).toBe(true);
	});

	it("starts the full runtime when bootstrap is complete and an admin user exists", () => {
		expect(shouldEnterOnboarding(true, true)).toBe(false);
	});
});

describe("logLegacyStateAudit", () => {
	it("writes a summary when legacy data remains", async () => {
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const sessionStore = {
			auditLegacyState: vi.fn(async () => ({
				legacyStateFiles: ["/sessions/issue-1.state.json"],
				sessionsMissingKind: ["github-mbrooks-yolomatic-issue-2-implementation"],
				malformedStateFiles: ["/sessions/issue-3.state.json"],
				clean: false,
			})),
		} as never;

		await logLegacyStateAudit(sessionStore);

		expect(writeSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				"legacy audit: 1 legacy state file(s), 1 session(s) missing kind, 1 malformed legacy file(s)",
			),
		);
		writeSpy.mockRestore();
	});

	it("does not write a summary when the audit is clean", async () => {
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const sessionStore = {
			auditLegacyState: vi.fn(async () => ({
				legacyStateFiles: [],
				sessionsMissingKind: [],
				malformedStateFiles: [],
				clean: true,
			})),
		} as never;

		await logLegacyStateAudit(sessionStore);

		expect(writeSpy).not.toHaveBeenCalledWith(expect.stringContaining("legacy audit:"));
		writeSpy.mockRestore();
	});

	it("logs a failure message when auditLegacyState throws an Error", async () => {
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const sessionStore = {
			auditLegacyState: vi.fn(async () => {
				throw new Error("audit boom");
			}),
		} as never;

		await logLegacyStateAudit(sessionStore);

		expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("legacy audit failed: audit boom"));
		writeSpy.mockRestore();
	});

	it("stringifies non-Error throws in the failure message", async () => {
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const sessionStore = {
			auditLegacyState: vi.fn(async () => {
				throw "not an error";
			}),
		} as never;

		await logLegacyStateAudit(sessionStore);

		expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("legacy audit failed: not an error"));
		writeSpy.mockRestore();
	});

	it("is a no-op when the session store does not implement auditLegacyState", async () => {
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await logLegacyStateAudit({} as never);
		expect(writeSpy).not.toHaveBeenCalled();
		writeSpy.mockRestore();
	});
});

describe("createOnboardingCompleteHandler", () => {
	function makeHandlerDeps(overrides: Partial<OnboardingCompleteHandlerDeps> = {}): OnboardingCompleteHandlerDeps {
		const stores = makeFakeStores();
		return {
			settingsStore: stores.settingsStore,
			sessionStore: stores.sessionStore,
			taskController: stores.taskController,
			repositoryStore: stores.repositoryStore,
			userStore: stores.userStore,
			getConfig: vi.fn(() => baseConfig),
			isBootstrapComplete: vi.fn(() => true),
			closeServer: vi.fn(async () => undefined),
			startRuntime: vi.fn(async () => ({}) as RuntimeGraph),
			...overrides,
		};
	}

	it("closes the onboarding server and starts the full runtime when bootstrap becomes complete", async () => {
		const nextConfig = { ...baseConfig, webhookSecret: "rotated" };
		const getConfig = vi.fn(() => nextConfig);
		const closeServer = vi.fn(async () => undefined);
		const startRuntime = vi.fn(async () => ({}) as RuntimeGraph);
		const userStore = { hasAnySync: vi.fn(() => true) } as never;
		const deps = makeHandlerDeps({ getConfig, closeServer, startRuntime, userStore });

		const handler = createOnboardingCompleteHandler(deps);
		await handler();

		expect(getConfig).toHaveBeenCalledWith(deps.settingsStore);
		expect(closeServer).toHaveBeenCalledTimes(1);
		expect(startRuntime).toHaveBeenCalledWith(
			nextConfig,
			expect.objectContaining({ settingsStore: deps.settingsStore, userStore: deps.userStore }),
		);
	});

	it("does not start the runtime when bootstrap is still incomplete", async () => {
		const closeServer = vi.fn(async () => undefined);
		const startRuntime = vi.fn(async () => ({}) as RuntimeGraph);
		const isBootstrapComplete = vi.fn(() => false);
		const deps = makeHandlerDeps({ closeServer, startRuntime, isBootstrapComplete });

		const handler = createOnboardingCompleteHandler(deps);
		await handler();

		expect(closeServer).not.toHaveBeenCalled();
		expect(startRuntime).not.toHaveBeenCalled();
	});

	it("does not start the runtime when no admin user exists yet", async () => {
		const closeServer = vi.fn(async () => undefined);
		const startRuntime = vi.fn(async () => ({}) as RuntimeGraph);
		const userStore = { hasAnySync: vi.fn(() => false) } as never;
		const deps = makeHandlerDeps({ closeServer, startRuntime, userStore });

		const handler = createOnboardingCompleteHandler(deps);
		await handler();

		expect(closeServer).not.toHaveBeenCalled();
		expect(startRuntime).not.toHaveBeenCalled();
	});

	it("only transitions once even if the callback fires again", async () => {
		const closeServer = vi.fn(async () => undefined);
		const startRuntime = vi.fn(async () => ({}) as RuntimeGraph);
		const deps = makeHandlerDeps({ closeServer, startRuntime });

		const handler = createOnboardingCompleteHandler(deps);
		await handler();
		await handler();

		expect(closeServer).toHaveBeenCalledTimes(1);
		expect(startRuntime).toHaveBeenCalledTimes(1);
	});
});

describe("main", () => {
	it("starts the full runtime directly when bootstrap is complete and an admin user exists", async () => {
		const stores = makeFakeStores();
		const startupState = vi.fn(() => stores);
		const startRuntime = vi.fn(async () => ({}) as RuntimeGraph);
		const { createWebhookServer } = captureServer();

		await main({
			startupState,
			startRuntime,
			createWebhookServer,
			configureLogging: vi.fn(),
		});

		expect(startupState).toHaveBeenCalledTimes(1);
		expect(startRuntime).toHaveBeenCalledWith(
			baseConfig,
			expect.objectContaining({
				settingsStore: stores.settingsStore,
				sessionStore: stores.sessionStore,
				repositoryStore: stores.repositoryStore,
				userStore: stores.userStore,
				taskController: stores.taskController,
			}) as RuntimeDeps,
		);
		expect(createWebhookServer).not.toHaveBeenCalled();
	});

	it("starts in onboarding mode with noOpHandlers and listens on the configured port when bootstrap is incomplete", async () => {
		const stores = makeFakeStores();
		const startupState = vi.fn(() => stores);
		const startRuntime = vi.fn(async () => ({}) as RuntimeGraph);
		const isBootstrapComplete = vi.fn(() => false);
		const { createWebhookServer, options, instances } = captureServer();

		await main({
			startupState,
			startRuntime,
			createWebhookServer,
			isBootstrapComplete,
			configureLogging: vi.fn(),
		});

		expect(createWebhookServer).toHaveBeenCalledTimes(1);
		expect(options[0].handlers).toBe(noOpHandlers);
		expect(options[0].onOnboardingComplete).toBeTypeOf("function");
		expect(instances[0].listen).toHaveBeenCalledWith(6767, expect.any(Function));
		expect(startRuntime).not.toHaveBeenCalled();
	});

	it("starts in onboarding mode when no admin user exists even if bootstrap is complete", async () => {
		const stores = makeFakeStores({
			userStore: { hasAnySync: vi.fn(() => false) } as never,
		});
		const startupState = vi.fn(() => stores);
		const startRuntime = vi.fn(async () => ({}) as RuntimeGraph);
		const { createWebhookServer } = captureServer();

		await main({
			startupState,
			startRuntime,
			createWebhookServer,
			configureLogging: vi.fn(),
		});

		expect(createWebhookServer).toHaveBeenCalledTimes(1);
		expect(startRuntime).not.toHaveBeenCalled();
	});

	it("transitions from onboarding to full runtime when onOnboardingComplete fires", async () => {
		const stores = makeFakeStores();
		const startupState = vi.fn(() => stores);
		const nextConfig = { ...baseConfig, webhookSecret: "rotated" };
		const loadConfig = vi.fn(() => nextConfig);
		const startRuntime = vi.fn(async () => ({}) as RuntimeGraph);
		const isBootstrapComplete = vi.fn(() => false);
		const { createWebhookServer, options, instances } = captureServer();

		await main({
			startupState,
			startRuntime,
			createWebhookServer,
			isBootstrapComplete,
			loadConfig,
			configureLogging: vi.fn(),
		});

		// main enters onboarding because the initial isBootstrapComplete returns false.
		expect(createWebhookServer).toHaveBeenCalledTimes(1);
		expect(startRuntime).not.toHaveBeenCalled();

		// The onboarding server closes when the wizard completes.
		instances[0].close.mockImplementation((cb?: (err?: Error) => void) => {
			if (typeof cb === "function") cb();
			return undefined;
		});
		isBootstrapComplete.mockReturnValue(true);

		const onOnboardingComplete = options[0].onOnboardingComplete as () => Promise<void>;
		await onOnboardingComplete();

		expect(instances[0].close).toHaveBeenCalled();
		expect(loadConfig).toHaveBeenCalledWith(stores.settingsStore);
		expect(startRuntime).toHaveBeenCalledWith(nextConfig, expect.objectContaining({}) as RuntimeDeps);
	});

	it("does not transition when onOnboardingComplete fires before bootstrap is complete", async () => {
		const stores = makeFakeStores();
		const startupState = vi.fn(() => stores);
		const startRuntime = vi.fn(async () => ({}) as RuntimeGraph);
		const isBootstrapComplete = vi.fn(() => false);
		const loadConfig = vi.fn(() => baseConfig);
		const { createWebhookServer, options } = captureServer();

		await main({
			startupState,
			startRuntime,
			createWebhookServer,
			isBootstrapComplete,
			loadConfig,
			configureLogging: vi.fn(),
		});

		const onOnboardingComplete = options[0].onOnboardingComplete as () => Promise<void>;
		await onOnboardingComplete();

		expect(startRuntime).not.toHaveBeenCalled();
	});

	it("does not register a settings change listener that syncs process.env", async () => {
		const stores = makeFakeStores();
		const startupState = vi.fn(() => stores);
		await main({
			startupState,
			startRuntime: vi.fn(async () => ({}) as RuntimeGraph),
			createWebhookServer: captureServer().createWebhookServer,
			configureLogging: vi.fn(),
		});
		// The migration removed the syncConfigToEnv live-sync listener; live model
		// settings now flow through the injected runtime settings provider.
		expect(stores.settingsStore.onChange).not.toHaveBeenCalled();
	});

	it("does not start the runtime (and therefore does not prebuild the worker) in onboarding-only mode", async () => {
		const stores = makeFakeStores();
		const startupState = vi.fn(() => stores);
		const startRuntime = vi.fn(async () => ({}) as RuntimeGraph);
		const isBootstrapComplete = vi.fn(() => false);

		await main({
			startupState,
			startRuntime,
			createWebhookServer: captureServer().createWebhookServer,
			isBootstrapComplete,
			configureLogging: vi.fn(),
		});

		expect(startRuntime).not.toHaveBeenCalled();
	});

	it("runs the legacy state audit during startup", async () => {
		const auditLegacyState = vi.fn(async () => ({
			legacyStateFiles: ["/sessions/issue-1.state.json"],
			sessionsMissingKind: [],
			malformedStateFiles: [],
			clean: false,
		}));
		const stores = makeFakeStores({
			sessionStore: { auditLegacyState } as never,
		});
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await main({
			startupState: vi.fn(() => stores),
			startRuntime: vi.fn(async () => ({}) as RuntimeGraph),
			createWebhookServer: captureServer().createWebhookServer,
			configureLogging: vi.fn(),
		});

		expect(auditLegacyState).toHaveBeenCalledTimes(1);
		expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("legacy audit: 1 legacy state file(s)"));
		writeSpy.mockRestore();
	});
});