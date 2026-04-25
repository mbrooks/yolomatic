import { beforeEach, describe, expect, it } from "vitest";

import { getWorkspaceConfig } from "./config.js";

describe("getWorkspaceConfig", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.GITHUB_USERNAME;
		delete process.env.GITHUB_TOKEN;
		delete process.env.DEFAULT_BRANCH;
		delete process.env.WORKSPACES_DIR;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("returns defaults for optional values", () => {
		process.env.GITHUB_USERNAME = "user";
		process.env.GITHUB_TOKEN = "token";
		const config = getWorkspaceConfig();
		expect(config.defaultBranch).toBe("main");
		expect(config.workspacesDir).toBeTruthy();
	});

	it("reads environment variables", () => {
		process.env.GITHUB_USERNAME = "user";
		process.env.GITHUB_TOKEN = "token";
		process.env.DEFAULT_BRANCH = "develop";
		process.env.WORKSPACES_DIR = "/tmp/workspaces";
		const config = getWorkspaceConfig();
		expect(config.defaultBranch).toBe("develop");
		expect(config.workspacesDir).toBe("/tmp/workspaces");
	});

	it("throws when GITHUB_USERNAME is missing", () => {
		process.env.GITHUB_TOKEN = "token";
		expect(() => getWorkspaceConfig()).toThrow("GITHUB_USERNAME environment variable is required");
	});

	it("throws when GITHUB_TOKEN is missing", () => {
		process.env.GITHUB_USERNAME = "user";
		expect(() => getWorkspaceConfig()).toThrow("GITHUB_TOKEN environment variable is required");
	});
});
