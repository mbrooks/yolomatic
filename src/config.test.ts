import { beforeEach, describe, expect, it, afterEach } from "vitest";
import { unlinkSync } from "node:fs";

import { getConfig, isBootstrapComplete, getBootstrapMissingFields } from "./config.js";
import { SettingsStore } from "./settings/store.js";

const TEST_DB = "/tmp/tars-config-test.sqlite";

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
		delete process.env.AUTO_START;
		delete process.env.WEBHOOK_SECRET;
		delete process.env.SESSIONS_DIR;
		delete process.env.DEFAULT_BRANCH;
		delete process.env.GITHUB_TOKEN;
		delete process.env.GITHUB_USERNAME;
		delete process.env.WORKSPACES_DIR;
		delete process.env.SOUL_PATH;
		delete process.env.TARS_SELF_REPORT_ENABLED;
		delete process.env.MAX_ITERATIONS;
		delete process.env.ADMIN_USERNAME;
		delete process.env.ADMIN_PASSWORD;
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
		expect(config.port).toBe(3000);
		expect(config.autoStart).toBe(false);
		expect(config.defaultBranch).toBe("main");
		expect(config.sessionsDir).toBeTruthy();
		expect(config.workspacesDir).toBeTruthy();
		expect(config.soulPath).toBeTruthy();
		expect(config.selfReportEnabled).toBe(true);
		expect(config.maxIterations).toBe(3);
		expect(config.adminUsername).toBeUndefined();
		expect(config.adminPassword).toBeUndefined();
	});

	it("reads environment variables", () => {
		process.env.PORT = "8080";
		process.env.AUTO_START = "true";
		process.env.WEBHOOK_SECRET = "secret";
		process.env.SESSIONS_DIR = "/tmp/sessions";
		process.env.DEFAULT_BRANCH = "develop";
		process.env.GITHUB_TOKEN = "token";
		process.env.GITHUB_USERNAME = "user";
		process.env.WORKSPACES_DIR = "/tmp/workspaces";
		process.env.SOUL_PATH = "/tmp/SOUL.md";
		process.env.MAX_ITERATIONS = "5";
		process.env.ADMIN_USERNAME = "admin";
		process.env.ADMIN_PASSWORD = "secret";

		const config = getConfig(createStore());
		expect(config.port).toBe(8080);
		expect(config.autoStart).toBe(true);
		expect(config.webhookSecret).toBe("secret");
		expect(config.sessionsDir).toBe("/tmp/sessions");
		expect(config.defaultBranch).toBe("develop");
		expect(config.githubToken).toBe("token");
		expect(config.githubUsername).toBe("user");
		expect(config.workspacesDir).toBe("/tmp/workspaces");
		expect(config.soulPath).toBe("/tmp/SOUL.md");
		expect(config.selfReportEnabled).toBe(true);
		expect(config.maxIterations).toBe(5);
		expect(config.adminUsername).toBe("admin");
		expect(config.adminPassword).toBe("secret");
	});

	it("returns empty strings for missing required settings without throwing", () => {
		const config = getConfig(createStore());
		expect(config.webhookSecret).toBe("");
		expect(config.githubToken).toBe("");
		expect(config.githubUsername).toBe("");
	});

	it("reads TARS_SELF_REPORT_ENABLED", () => {
		process.env.WEBHOOK_SECRET = "secret";
		process.env.GITHUB_TOKEN = "token";
		process.env.GITHUB_USERNAME = "user";
		process.env.TARS_SELF_REPORT_ENABLED = "false";

		const config = getConfig(createStore());
		expect(config.selfReportEnabled).toBe(false);
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
		} as unknown as import("./config.js").AppConfig)).toBe(false);
	});

	it("returns true when all required fields are present", () => {
		expect(isBootstrapComplete({
			webhookSecret: "secret",
			githubToken: "token",
			githubUsername: "user",
			adminUsername: "admin",
			adminPassword: "pass",
		} as unknown as import("./config.js").AppConfig)).toBe(true);
	});
});

describe("getBootstrapMissingFields", () => {
	it("lists all missing fields", () => {
		const missing = getBootstrapMissingFields({
			webhookSecret: "",
			githubToken: "tok",
			githubUsername: "",
			adminUsername: undefined,
			adminPassword: "pass",
		} as unknown as import("./config.js").AppConfig);
		expect(missing).toContain("webhook_secret");
		expect(missing).toContain("github_username");
		expect(missing).toContain("admin_username");
		expect(missing).not.toContain("github_token");
		expect(missing).not.toContain("admin_password");
	});
});
