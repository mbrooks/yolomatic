import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { unlinkSync } from "node:fs";
import { SettingsStore } from "./store.js";
import { SETTING_DEFINITIONS } from "./model.js";

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
		store.set("self_report_enabled", "true");
		expect(store.getBoolean("self_report_enabled")).toBe(true);
		store.set("self_report_enabled", "false");
		expect(store.getBoolean("self_report_enabled")).toBe(false);
	});

	it("getAllViews includes category from definition", () => {
		store.applyDefaults();
		const views = store.getAllViews();
		const portView = views.find((v) => v.key === "port");
		expect(portView?.category).toBe("server");
	});

	it("setTyped coerces values correctly", () => {
		store.setTyped("self_report_enabled", true);
		expect(store.get("self_report_enabled")).toBe("true");
		store.setTyped("port", 42);
		expect(store.get("port")).toBe("42");
		store.setTyped("default_branch", "develop");
		expect(store.get("default_branch")).toBe("develop");
	});

	it("getAllViews blanks out sensitive field values", () => {
		store.seedFromEnv({ WEBHOOK_SECRET: "secret123", GITHUB_TOKEN: "token456", ADMIN_PASSWORD: "pass789" });
		const views = store.getAllViews();
		const secretView = views.find((v) => v.key === "webhook_secret");
		const tokenView = views.find((v) => v.key === "github_token");
		const passView = views.find((v) => v.key === "admin_password");
		expect(secretView?.value).toBe("");
		expect(tokenView?.value).toBe("");
		expect(passView?.value).toBe("");
	});

	it("getAllViews returns actual values for non-sensitive fields", () => {
		store.seedFromEnv({ GITHUB_USERNAME: "tars-bot", PORT: "9090" });
		const views = store.getAllViews();
		const userView = views.find((v) => v.key === "github_username");
		const portView = views.find((v) => v.key === "port");
		expect(userView?.value).toBe("tars-bot");
		expect(portView?.value).toBe(9090);
	});

	it("getBoolean falls back to definition default", () => {
		expect(store.getBoolean("self_report_enabled")).toBe(true);
	});

	it("getBoolean returns false for unknown keys", () => {
		expect(store.getBoolean("nonexistent_key")).toBe(false);
	});

	it("set throws for unknown keys", () => {
		expect(() => store.set("nonexistent_key", "value")).toThrow("Unknown setting: nonexistent_key");
	});

	it("setTyped throws for unknown keys", () => {
		expect(() => store.setTyped("nonexistent_key", "value")).toThrow("Unknown setting: nonexistent_key");
	});

	it("isEmpty returns true for fresh store", () => {
		expect(store.isEmpty()).toBe(true);
		store.set("port", "6767");
		expect(store.isEmpty()).toBe(false);
	});

	describe("env priority", () => {
		const originalEnv = process.env;
		const envVars = SETTING_DEFINITIONS.map((d) => d.envVar);

		beforeEach(() => {
			process.env = { ...originalEnv };
			for (const name of envVars) delete process.env[name];
		});

		afterEach(() => {
			process.env = originalEnv;
		});

		it("get() returns the env value over the SQLite value", () => {
			store.set("port", "7000");
			expect(store.get("port")).toBe("7000");
			process.env.PORT = "8080";
			expect(store.get("port")).toBe("8080");
		});

		it("getNumber() and getBoolean() prefer env over SQLite", () => {
			store.set("port", "7000");
			store.set("self_report_enabled", "false");
			process.env.PORT = "8080";
			process.env.TARS_SELF_REPORT_ENABLED = "true";
			expect(store.getNumber("port")).toBe(8080);
			expect(store.getBoolean("self_report_enabled")).toBe(true);
		});

		it("falls back to SQLite when env is unset", () => {
			store.set("port", "7000");
			expect(store.get("port")).toBe("7000");
			expect(store.getNumber("port")).toBe(7000);
		});

		it("falls back to the definition default when neither env nor SQLite is set", () => {
			expect(store.getNumber("port")).toBe(6767);
			expect(store.getBoolean("self_report_enabled")).toBe(true);
		});

		it("ignores invalid env values and falls back to SQLite", () => {
			store.set("port", "7000");
			process.env.PORT = "not-a-number";
			expect(store.get("port")).toBe("7000");
			expect(store.getNumber("port")).toBe(7000);
		});

		it("treats whitespace-only env values as unset", () => {
			store.set("github_username", "stored-user");
			process.env.GITHUB_USERNAME = "   ";
			expect(store.get("github_username")).toBe("stored-user");
		});

		it("getEnvSource reports env vs database", () => {
			store.set("port", "7000");
			expect(store.getEnvSource("port")).toBe("database");
			process.env.PORT = "8080";
			expect(store.getEnvSource("port")).toBe("env");
			delete process.env.PORT;
			expect(store.getEnvSource("port")).toBe("database");
		});

		it("getAllViews sets envSource to env for env-sourced settings", () => {
			store.set("port", "7000");
			store.set("github_token", "stored-tok");
			process.env.PORT = "8080";
			const views = store.getAllViews();
			const portView = views.find((v) => v.key === "port");
			const tokenView = views.find((v) => v.key === "github_token");
			expect(portView?.envSource).toBe("env");
			expect(portView?.value).toBe(8080);
			expect(tokenView?.envSource).toBe("database");
		});

		it("getAllViews reports envSource env for sensitive settings while still redacting the value", () => {
			process.env.GITHUB_TOKEN = "ghp_secret";
			const views = store.getAllViews();
			const tokenView = views.find((v) => v.key === "github_token");
			expect(tokenView?.envSource).toBe("env");
			expect(tokenView?.value).toBe("");
			expect(tokenView?.sensitive).toBe(true);
		});

		it("getAllViews includes envSource for every setting", () => {
			store.applyDefaults();
			const views = store.getAllViews();
			for (const view of views) {
				expect(view.envSource).toBe("database");
		}
		});

		it("seedFromEnv is a no-op for keys already controlled by env", () => {
			process.env.PORT = "8080";
			store.seedFromEnv();
			// SQLite never receives a row because env already satisfies get().
			expect(store.getAll().find((e) => e.key === "port")).toBeUndefined();
			expect(store.get("port")).toBe("8080");
		});
	});

	describe("onChange", () => {
		it("fires with (key, value) after set", () => {
			const listener = vi.fn();
			store.onChange(listener);
			store.set("port", "5555");
			expect(listener).toHaveBeenCalledWith("port", "5555");
		});

		it("fires with (key, formatted) after setTyped", () => {
			const listener = vi.fn();
			store.onChange(listener);
			store.setTyped("self_report_enabled", true);
			expect(listener).toHaveBeenCalledWith("self_report_enabled", "true");
		});

		it("unsubscribe stops further notifications", () => {
			const listener = vi.fn();
			const unsubscribe = store.onChange(listener);
			unsubscribe();
			store.set("port", "7777");
			expect(listener).not.toHaveBeenCalled();
		});

		it("isolates throwing listeners and does not break the save", () => {
			const throwing = vi.fn(() => {
				throw new Error("boom");
			});
			const healthy = vi.fn();
			store.onChange(throwing);
			store.onChange(healthy);
			store.set("port", "8888");
			expect(throwing).toHaveBeenCalledWith("port", "8888");
			expect(healthy).toHaveBeenCalledWith("port", "8888");
			expect(store.get("port")).toBe("8888");
		});
	});
});
