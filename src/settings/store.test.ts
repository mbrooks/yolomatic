import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "node:fs";
import { SettingsStore } from "./store.js";

const TEST_DB = "/tmp/tars-settings-store-test.sqlite";

describe("SettingsStore", () => {
	let store: SettingsStore;

	beforeEach(() => {
		try {
			unlinkSync(TEST_DB);
		} catch {
			// ignore
		}
		store = new SettingsStore(TEST_DB);
	});

	afterEach(() => {
		try {
			unlinkSync(TEST_DB);
		} catch {
			// ignore
		}
	});

	it("seeds from env and applies defaults", () => {
		store.seedFromEnv({ PORT: "8080", WEBHOOK_SECRET: "shh" });
		store.applyDefaults();
		expect(store.getString("port")).toBe("8080");
		expect(store.getString("webhook_secret")).toBe("shh");
		expect(store.getString("default_branch")).toBe("main");
	});

	it("getString returns existing value", () => {
		store.seedFromEnv({ GITHUB_TOKEN: "tok" });
		expect(store.getString("github_token")).toBe("tok");
	});

	it("getNumber parses integer", () => {
		store.set("port", "9000");
		expect(store.getNumber("port")).toBe(9000);
	});

	it("getBoolean parses true/false", () => {
		store.set("auto_start", "true");
		expect(store.getBoolean("auto_start")).toBe(true);
		store.set("auto_start", "false");
		expect(store.getBoolean("auto_start")).toBe(false);
	});

	it("getAllViews returns all definitions", () => {
		store.applyDefaults();
		const views = store.getAllViews();
		expect(views.length).toBeGreaterThan(0);
		const portView = views.find((v) => v.key === "port");
		expect(portView).toBeDefined();
		expect(portView?.type).toBe("number");
		expect(portView?.requiresRestart).toBe(true);
	});

	it("setTyped coerces values correctly", () => {
		store.setTyped("auto_start", true);
		expect(store.get("auto_start")).toBe("true");
		store.setTyped("port", 42);
		expect(store.get("port")).toBe("42");
		store.setTyped("default_branch", "develop");
		expect(store.get("default_branch")).toBe("develop");
	});

	it("isEmpty returns true for fresh store", () => {
		expect(store.isEmpty()).toBe(true);
		store.set("port", "3000");
		expect(store.isEmpty()).toBe(false);
	});
});
