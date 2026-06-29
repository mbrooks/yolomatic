import { beforeEach, describe, expect, it, afterEach } from "vitest";
import { unlinkSync } from "node:fs";

import { getWorkspaceConfig } from "./config.js";
import { SettingsStore } from "../settings/store.js";

const TEST_DB = "/tmp/tars-workspace-config-test.sqlite";

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

describe.sequential("getWorkspaceConfig", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.GITHUB_USERNAME;
		delete process.env.GITHUB_TOKEN;
		delete process.env.DEFAULT_BRANCH;
		delete process.env.WORKSPACES_DIR;
		delete process.env.MAX_WORKTREES;
		delete process.env.WORKTREE_EVICTION_STRATEGY;
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
		process.env.GITHUB_USERNAME = "user";
		process.env.GITHUB_TOKEN = "token";
		const config = getWorkspaceConfig(createStore());
		expect(config.defaultBranch).toBe("main");
		expect(config.workspacesDir).toBeTruthy();
		expect(config.maxWorktrees).toBe(10);
		expect(config.evictionStrategy).toBe("lru");
	});

	it("reads environment variables", () => {
		process.env.GITHUB_USERNAME = "user";
		process.env.GITHUB_TOKEN = "token";
		process.env.DEFAULT_BRANCH = "develop";
		process.env.WORKSPACES_DIR = "/tmp/workspaces";
		process.env.MAX_WORKTREES = "5";
		process.env.WORKTREE_EVICTION_STRATEGY = "fifo";
		const config = getWorkspaceConfig(createStore());
		expect(config.defaultBranch).toBe("develop");
		expect(config.workspacesDir).toBe("/tmp/workspaces");
		expect(config.maxWorktrees).toBe(5);
		expect(config.evictionStrategy).toBe("fifo");
	});

	it("floors maxWorktrees to 1", () => {
		process.env.GITHUB_USERNAME = "user";
		process.env.GITHUB_TOKEN = "token";
		process.env.MAX_WORKTREES = "0";
		const config = getWorkspaceConfig(createStore());
		expect(config.maxWorktrees).toBe(1);
	});

	it("throws when GITHUB_USERNAME is missing", () => {
		process.env.GITHUB_TOKEN = "token";
		expect(() => getWorkspaceConfig(createStore())).toThrow("Setting github_username is required");
	});

	it("throws when GITHUB_TOKEN is missing", () => {
		process.env.GITHUB_USERNAME = "user";
		expect(() => getWorkspaceConfig(createStore())).toThrow("Setting github_token is required");
	});
});
