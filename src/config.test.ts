import { beforeEach, describe, expect, it } from "vitest";

import { getConfig } from "./config.js";

describe("getConfig", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.PORT;
		delete process.env.AUTO_START;
		delete process.env.WEBHOOK_SECRET;
		delete process.env.SESSIONS_DIR;
		delete process.env.ARCHIVE_DIR;
		delete process.env.DEFAULT_BRANCH;
		delete process.env.GITHUB_TOKEN;
		delete process.env.GITHUB_USERNAME;
		delete process.env.WORKSPACES_DIR;
		delete process.env.SOUL_PATH;
		delete process.env.TARS_SELF_REPORT_ENABLED;
		delete process.env.MAX_ITERATIONS;
		delete process.env.ADMIN_USERNAME;
		delete process.env.ADMIN_PASSWORD;
		delete process.env.STALE_THRESHOLD_MS;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("returns defaults for optional values", () => {
		process.env.WEBHOOK_SECRET = "secret";
		process.env.GITHUB_TOKEN = "token";
		process.env.GITHUB_USERNAME = "user";

		const config = getConfig();
		expect(config.port).toBe(3000);
		expect(config.autoStart).toBe(false);
		expect(config.defaultBranch).toBe("main");
		expect(config.sessionsDir).toBeTruthy();
		expect(config.archiveDir).toBeTruthy();
		expect(config.workspacesDir).toBeTruthy();
		expect(config.soulPath).toBeTruthy();
		expect(config.selfReportEnabled).toBe(true);
		expect(config.maxIterations).toBe(3);
		expect(config.adminUsername).toBeUndefined();
		expect(config.adminPassword).toBeUndefined();
		expect(config.staleThresholdMs).toBe(14400000);
	});

	it("reads environment variables", () => {
		process.env.PORT = "8080";
		process.env.AUTO_START = "true";
		process.env.WEBHOOK_SECRET = "secret";
		process.env.SESSIONS_DIR = "/tmp/sessions";
		process.env.ARCHIVE_DIR = "/tmp/archive";
		process.env.DEFAULT_BRANCH = "develop";
		process.env.GITHUB_TOKEN = "token";
		process.env.GITHUB_USERNAME = "user";
		process.env.WORKSPACES_DIR = "/tmp/workspaces";
		process.env.SOUL_PATH = "/tmp/SOUL.md";
		process.env.MAX_ITERATIONS = "5";
		process.env.ADMIN_USERNAME = "admin";
		process.env.ADMIN_PASSWORD = "secret";
		process.env.STALE_THRESHOLD_MS = "7200000";

		const config = getConfig();
		expect(config.port).toBe(8080);
		expect(config.autoStart).toBe(true);
		expect(config.webhookSecret).toBe("secret");
		expect(config.sessionsDir).toBe("/tmp/sessions");
		expect(config.archiveDir).toBe("/tmp/archive");
		expect(config.defaultBranch).toBe("develop");
		expect(config.githubToken).toBe("token");
		expect(config.githubUsername).toBe("user");
		expect(config.workspacesDir).toBe("/tmp/workspaces");
		expect(config.soulPath).toBe("/tmp/SOUL.md");
		expect(config.selfReportEnabled).toBe(true);
		expect(config.maxIterations).toBe(5);
		expect(config.adminUsername).toBe("admin");
		expect(config.adminPassword).toBe("secret");
		expect(config.staleThresholdMs).toBe(7200000);
	});

	it("reads TARS_SELF_REPORT_ENABLED", () => {
		process.env.WEBHOOK_SECRET = "secret";
		process.env.GITHUB_TOKEN = "token";
		process.env.GITHUB_USERNAME = "user";
		process.env.TARS_SELF_REPORT_ENABLED = "false";

		const config = getConfig();
		expect(config.selfReportEnabled).toBe(false);
	});

	it("throws when WEBHOOK_SECRET is missing", () => {
		process.env.WEBHOOK_SECRET = "";
		process.env.GITHUB_TOKEN = "token";
		process.env.GITHUB_USERNAME = "user";
		expect(() => getConfig()).toThrow("WEBHOOK_SECRET environment variable is required");
	});

	it("throws when GITHUB_TOKEN is missing", () => {
		process.env.WEBHOOK_SECRET = "secret";
		process.env.GITHUB_TOKEN = "";
		process.env.GITHUB_USERNAME = "user";
		expect(() => getConfig()).toThrow("GITHUB_TOKEN environment variable is required");
	});

	it("throws when GITHUB_USERNAME is missing", () => {
		process.env.WEBHOOK_SECRET = "secret";
		process.env.GITHUB_TOKEN = "token";
		process.env.GITHUB_USERNAME = "";
		expect(() => getConfig()).toThrow("GITHUB_USERNAME environment variable is required");
	});
});
