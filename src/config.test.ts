import { beforeEach, describe, expect, it, afterEach } from "vitest";
import { unlinkSync } from "node:fs";

import { getConfig, isBootstrapComplete, getBootstrapMissingFields, normalizeAdminPath, adminWebSocketPath, DEFAULT_ADMIN_PATH, DEFAULT_ADMIN_DEFAULT_PAGE } from "./config.js";
import { SettingsStore } from "./settings/store.js";

const TEST_DB = "/tmp/yolomatic-config-test.sqlite";

function createStore(): SettingsStore {
	try {
		unlinkSync(TEST_DB);
	} catch {
		// ignore
	}
	const store = new SettingsStore(TEST_DB);
	store.seedFromEnv();
	store.applyDefaults();
	return store;
}

describe("getConfig", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.PORT;
		delete process.env.WEBHOOK_SECRET;
		delete process.env.SESSIONS_DIR;
		delete process.env.DEFAULT_BRANCH;
		delete process.env.GITHUB_TOKEN;
		delete process.env.GITHUB_USERNAME;
		delete process.env.WORKSPACES_DIR;
		delete process.env.SOUL_PATH;
		delete process.env.YOLO_SELF_REPORT_ENABLED;
		delete process.env.ARCHIVE_DIR;
		delete process.env.MEMORY_DIR;
		delete process.env.CLEANUP_RETENTION_DAYS;
		delete process.env.ADMIN_USERNAME;
		delete process.env.ADMIN_PASSWORD;
		delete process.env.ONBOARDING_COMPLETE;
		delete process.env.GITHUB_EVENT_MODE;
		delete process.env.GITHUB_POLL_INTERVAL_MS;
		delete process.env.YOLO_WORKER_CONTROL_BASE_URL;
		delete process.env.YOLO_WORKER_DOCKER_NETWORK_MODE;
		delete process.env.OPENAI_API_KEY;
		delete process.env.IDLE_WORKING_FAIL_MS;
	});

	afterEach(() => {
		process.env = originalEnv;
		try {
			unlinkSync(TEST_DB);
		} catch {
			// ignore
		}
	});

	it("returns defaults for optional values", () => {
		process.env.WEBHOOK_SECRET = "secret";
		process.env.GITHUB_TOKEN = "token";
		process.env.GITHUB_USERNAME = "user";

		const config = getConfig(createStore());
		expect(config.port).toBe(6767);
		expect(config.defaultBranch).toBe("main");
		expect(config.sessionsDir).toBeTruthy();
		expect(config.workspacesDir).toBeTruthy();
		expect(config.soulPath).toBeTruthy();
		expect(config.selfReportEnabled).toBe(true);
		expect(config.onboardingComplete).toBe(false);
		expect(config.githubEventMode).toBe("webhook");
		expect(config.githubPollIntervalMs).toBe(60000);
		expect(config.workerControlBaseUrl).toBe("http://host.docker.internal:6767");
		expect(config.workerDockerNetworkMode).toBeUndefined();
		expect(config.openaiApiKey).toBe("");
		expect(config.defaultWorkerTemplate).toBe("node");
	});

	it("reads optional environment variables", () => {
		process.env.WEBHOOK_SECRET = "secret";
		process.env.GITHUB_TOKEN = "token";
		process.env.GITHUB_USERNAME = "user";
		process.env.ARCHIVE_DIR = "/tmp/archive";
		process.env.MEMORY_DIR = "/tmp/memory";
		process.env.CLEANUP_RETENTION_DAYS = "0";

		const config = getConfig(createStore());
		expect(config.archiveDir).toBe("/tmp/archive");
		expect(config.memoryDir).toBe("/tmp/memory");
		expect(config.cleanupRetentionDays).toBeUndefined();
	});

	it("reads environment variables", () => {
		process.env.PORT = "8080";
		process.env.WEBHOOK_SECRET = "secret";
		process.env.SESSIONS_DIR = "/tmp/sessions";
		process.env.DEFAULT_BRANCH = "develop";
		process.env.GITHUB_TOKEN = "token";
		process.env.GITHUB_USERNAME = "user";
		process.env.WORKSPACES_DIR = "/tmp/workspaces";
		process.env.SOUL_PATH = "/tmp/SOUL.md";
		process.env.ADMIN_USERNAME = "admin";
		process.env.ADMIN_PASSWORD = "secret";
		process.env.ONBOARDING_COMPLETE = "true";
		process.env.GITHUB_EVENT_MODE = "both";
		process.env.GITHUB_POLL_INTERVAL_MS = "30000";
		process.env.YOLO_WORKER_CONTROL_BASE_URL = "http://worker-control.internal:9999";
		process.env.YOLO_WORKER_DOCKER_NETWORK_MODE = "container:yolomatic";
		process.env.OPENAI_API_KEY = "sk-test-key";

		const config = getConfig(createStore());
		expect(config.port).toBe(8080);
		expect(config.webhookSecret).toBe("secret");
		expect(config.sessionsDir).toBe("/tmp/sessions");
		expect(config.defaultBranch).toBe("develop");
		expect(config.githubToken).toBe("token");
		expect(config.githubUsername).toBe("user");
		expect(config.workspacesDir).toBe("/tmp/workspaces");
		expect(config.soulPath).toBe("/tmp/SOUL.md");
		expect(config.selfReportEnabled).toBe(true);
		expect(config.onboardingComplete).toBe(true);
		expect(config.githubEventMode).toBe("both");
		expect(config.githubPollIntervalMs).toBe(30000);
		expect(config.workerControlBaseUrl).toBe("http://worker-control.internal:9999");
		expect(config.workerDockerNetworkMode).toBe("container:yolomatic");
		expect(config.openaiApiKey).toBe("sk-test-key");
	});

	it("falls back to webhook mode for unknown GitHub event modes", () => {
		process.env.GITHUB_EVENT_MODE = "invalid";

		const config = getConfig(createStore());
		expect(config.githubEventMode).toBe("webhook");
	});

	it("returns empty strings for missing required settings without throwing", () => {
		const config = getConfig(createStore());
		expect(config.webhookSecret).toBe("");
		expect(config.githubToken).toBe("");
		expect(config.githubUsername).toBe("");
	});

	it("reads YOLO_SELF_REPORT_ENABLED", () => {
		process.env.WEBHOOK_SECRET = "secret";
		process.env.GITHUB_TOKEN = "token";
		process.env.GITHUB_USERNAME = "user";
		process.env.YOLO_SELF_REPORT_ENABLED = "false";

		const config = getConfig(createStore());
		expect(config.selfReportEnabled).toBe(false);
	});

	it("defaults idleWorkingFailMs to one hour", () => {
		process.env.WEBHOOK_SECRET = "secret";
		process.env.GITHUB_TOKEN = "token";
		process.env.GITHUB_USERNAME = "user";

		const config = getConfig(createStore());
		expect(config.idleWorkingFailMs).toBe(3600000);
	});

	it("reads idle_working_fail_ms from settings when set", () => {
		process.env.WEBHOOK_SECRET = "secret";
		process.env.GITHUB_TOKEN = "token";
		process.env.GITHUB_USERNAME = "user";
		const store = createStore();
		store.set("idle_working_fail_ms", "7200000");

		const config = getConfig(store);
		expect(config.idleWorkingFailMs).toBe(7200000);
	});

	it("returns undefined for invalid cleanup retention", () => {
		process.env.WEBHOOK_SECRET = "secret";
		process.env.GITHUB_TOKEN = "token";
		process.env.GITHUB_USERNAME = "user";
		process.env.CLEANUP_RETENTION_DAYS = "abc";

		const config = getConfig(createStore());
		expect(config.cleanupRetentionDays).toBeUndefined();
	});
});

describe("isBootstrapComplete", () => {
	it("returns false when required fields are missing", () => {
		expect(isBootstrapComplete({
			webhookSecret: "",
			githubToken: "",
			githubUsername: "",
			adminUsername: undefined,
			adminPassword: undefined,
			onboardingComplete: false,
		} as unknown as import("./config.js").AppConfig)).toBe(false);
	});

	it("returns false when required fields are present but onboarding is incomplete", () => {
		expect(isBootstrapComplete({
			webhookSecret: "secret",
			githubToken: "token",
			githubUsername: "user",
			onboardingComplete: false,
		} as unknown as import("./config.js").AppConfig)).toBe(false);
	});

	it("returns true when all required fields are present and onboarding is complete", () => {
		expect(isBootstrapComplete({
			webhookSecret: "secret",
			githubToken: "token",
			githubUsername: "user",
			onboardingComplete: true,
		} as unknown as import("./config.js").AppConfig)).toBe(true);
	});

	it("returns true for polling mode without a webhook secret", () => {
		expect(isBootstrapComplete({
			webhookSecret: "",
			githubEventMode: "polling",
			githubToken: "token",
			githubUsername: "user",
			onboardingComplete: true,
		} as unknown as import("./config.js").AppConfig)).toBe(true);
	});

	it("returns false for webhook mode without a webhook secret", () => {
		expect(isBootstrapComplete({
			webhookSecret: "",
			githubEventMode: "webhook",
			githubToken: "token",
			githubUsername: "user",
			onboardingComplete: true,
		} as unknown as import("./config.js").AppConfig)).toBe(false);
	});
});

describe("normalizeAdminPath", () => {
	it("returns the default when the value is empty", () => {
		expect(normalizeAdminPath(undefined)).toBe(DEFAULT_ADMIN_PATH);
		expect(normalizeAdminPath("")).toBe(DEFAULT_ADMIN_PATH);
		expect(normalizeAdminPath("   ")).toBe(DEFAULT_ADMIN_PATH);
	});

	it("ensures the path starts with a slash", () => {
		expect(normalizeAdminPath("custom/admin")).toBe("/custom/admin");
	});

	it("strips trailing slashes except for root", () => {
		expect(normalizeAdminPath("/yolomatic/admin/")).toBe("/yolomatic/admin");
		expect(normalizeAdminPath("/yolomatic/admin///")).toBe("/yolomatic/admin");
	});

	it("preserves the root path", () => {
		expect(normalizeAdminPath("/")).toBe("/");
	});
});

describe("adminWebSocketPath", () => {
	it("appends /ws to a non-root admin path", () => {
		expect(adminWebSocketPath("/yolomatic/admin")).toBe("/yolomatic/admin/ws");
	});

	it("returns /ws for the root admin path", () => {
		expect(adminWebSocketPath("/")).toBe("/ws");
	});
});

describe("issue comment and admin-link settings", () => {
	it("exposes defaults for issue comment and admin-link settings", () => {
		process.env.WEBHOOK_SECRET = "secret";
		process.env.GITHUB_TOKEN = "token";
		process.env.GITHUB_USERNAME = "user";

		const config = getConfig(createStore());
		expect(config.issueNewCommentEnabled).toBe(true);
		expect(config.issueAdminLinkInCommentsEnabled).toBe(true);
		expect(config.adminBaseUrl).toBeUndefined();
	});

	it("reads stored issue comment and admin-link settings", () => {
		const store = createStore();
		store.set("issue_new_comment_enabled", "false");
		store.set("issue_admin_link_in_comments_enabled", "false");
		store.set("admin_base_url", "  http://host:6767/admin/  ");

		const config = getConfig(store);
		expect(config.issueNewCommentEnabled).toBe(false);
		expect(config.issueAdminLinkInCommentsEnabled).toBe(false);
		expect(config.adminBaseUrl).toBe("http://host:6767/admin/");
	});

	it("treats a blank admin_base_url as undefined", () => {
		const store = createStore();
		store.set("admin_base_url", "   ");

		const config = getConfig(store);
		expect(config.adminBaseUrl).toBeUndefined();
	});

	it("reads issue settings from env via seedFromEnv", () => {
		try {
			unlinkSync(TEST_DB);
		} catch {
			// ignore
		}
		const store = new SettingsStore(TEST_DB);
		store.seedFromEnv({
			YOLO_ISSUE_NEW_COMMENT_ENABLED: "false",
			YOLO_ISSUE_ADMIN_LINK_IN_COMMENTS_ENABLED: "false",
			YOLO_ADMIN_BASE_URL: "http://host:6767/admin",
		});
		store.applyDefaults();

		const config = getConfig(store);
		expect(config.issueNewCommentEnabled).toBe(false);
		expect(config.issueAdminLinkInCommentsEnabled).toBe(false);
		expect(config.adminBaseUrl).toBe("http://host:6767/admin");
	});

	it("exposes undefined for unset per-session model settings", () => {
		process.env.WEBHOOK_SECRET = "secret";
		process.env.GITHUB_TOKEN = "token";
		process.env.GITHUB_USERNAME = "user";
		delete process.env.PI_AGENT_MODEL;
		delete process.env.PI_AGENT_BUILD_MODEL;
		delete process.env.PI_AGENT_REFINEMENT_MODEL;

		const config = getConfig(createStore());
		expect(config.piAgentModel).toBeUndefined();
		expect(config.piAgentBuildModel).toBeUndefined();
		expect(config.piAgentRefinementModel).toBeUndefined();
	});

	it("reads stored per-session model settings", () => {
		const store = createStore();
		store.set("pi_agent_model", "default-model");
		store.set("pi_agent_build_model", "build-model");
		store.set("pi_agent_refinement_model", "refinement-model");

		const config = getConfig(store);
		expect(config.piAgentModel).toBe("default-model");
		expect(config.piAgentBuildModel).toBe("build-model");
		expect(config.piAgentRefinementModel).toBe("refinement-model");
	});

	it("seeds the per-session model settings from their env vars", () => {
		try {
			unlinkSync(TEST_DB);
		} catch {
			// ignore
		}
		const store = new SettingsStore(TEST_DB);
		store.seedFromEnv({
			PI_AGENT_BUILD_MODEL: "  build-model  ",
			PI_AGENT_REFINEMENT_MODEL: "refinement-model",
		});

		expect(store.get("pi_agent_build_model")).toBe("build-model");
		expect(store.get("pi_agent_refinement_model")).toBe("refinement-model");
	});
});

describe("admin config settings", () => {
	it("exposes default admin path and default page", () => {
		process.env.WEBHOOK_SECRET = "secret";
		process.env.GITHUB_TOKEN = "token";
		process.env.GITHUB_USERNAME = "user";

		const config = getConfig(createStore());
		expect(config.adminPath).toBe(DEFAULT_ADMIN_PATH);
		expect(config.adminDefaultPage).toBe(DEFAULT_ADMIN_DEFAULT_PAGE);
	});

	it("reads admin_path and admin_default_page from settings", () => {
		const store = createStore();
		store.set("admin_path", "/custom/admin/");
		store.set("admin_default_page", "#/repos");

		const config = getConfig(store);
		expect(config.adminPath).toBe("/custom/admin");
		expect(config.adminDefaultPage).toBe("#/repos");
	});

	it("normalizes an admin_path missing the leading slash", () => {
		const store = createStore();
		store.set("admin_path", "custom/admin");

		const config = getConfig(store);
		expect(config.adminPath).toBe("/custom/admin");
	});

	it("falls back to the default admin_default_page when blank", () => {
		const store = createStore();
		store.set("admin_default_page", "   ");

		const config = getConfig(store);
		expect(config.adminDefaultPage).toBe(DEFAULT_ADMIN_DEFAULT_PAGE);
	});
});

	describe("getBootstrapMissingFields", () => {
		it("lists all missing fields", () => {
			const missing = getBootstrapMissingFields({
				webhookSecret: "",
				githubToken: "tok",
				githubUsername: "",
				onboardingComplete: false,
			} as unknown as import("./config.js").AppConfig);
			expect(missing).toContain("webhook_secret");
			expect(missing).toContain("github_username");
			expect(missing).not.toContain("github_token");
			expect(missing).toContain("onboarding_complete");
		});

		it("returns empty when all fields are present", () => {
			const missing = getBootstrapMissingFields({
				webhookSecret: "secret",
				githubToken: "token",
				githubUsername: "user",
				onboardingComplete: true,
			} as unknown as import("./config.js").AppConfig);
			expect(missing).toHaveLength(0);
		});

		it("does not require a webhook secret for polling mode", () => {
			const missing = getBootstrapMissingFields({
				webhookSecret: "",
				githubEventMode: "polling",
				githubToken: "token",
				githubUsername: "user",
				onboardingComplete: true,
			} as unknown as import("./config.js").AppConfig);
			expect(missing).not.toContain("webhook_secret");
			expect(missing).toHaveLength(0);
		});

		it("requires a webhook secret for webhook mode", () => {
			const missing = getBootstrapMissingFields({
				webhookSecret: "",
				githubEventMode: "webhook",
				githubToken: "token",
				githubUsername: "user",
				onboardingComplete: true,
			} as unknown as import("./config.js").AppConfig);
			expect(missing).toContain("webhook_secret");
		});
	});
