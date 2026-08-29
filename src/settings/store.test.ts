import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { unlinkSync } from "node:fs";
import { SettingsStore } from "./store.js";

const TEST_DB = "/tmp/yolomatic-settings-store-test.sqlite";

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
		store.seedFromEnv({ WEBHOOK_SECRET: "secret123", GITHUB_TOKEN: "token456" });
		const views = store.getAllViews();
		const secretView = views.find((v) => v.key === "webhook_secret");
		const tokenView = views.find((v) => v.key === "github_token");
		expect(secretView?.value).toBe("");
		expect(tokenView?.value).toBe("");
	});

	it("getAllViews returns actual values for non-sensitive fields", () => {
		store.seedFromEnv({ GITHUB_USERNAME: "yolomatic-bot", PORT: "9090" });
		const views = store.getAllViews();
		const userView = views.find((v) => v.key === "github_username");
		const portView = views.find((v) => v.key === "port");
		expect(userView?.value).toBe("yolomatic-bot");
		expect(portView?.value).toBe(9090);
	});

	it("getBoolean falls back to definition default", () => {
		expect(store.getBoolean("self_report_enabled")).toBe(true);
	});

	it("round-trips the issue comment, admin-link toggle, and admin base url settings", () => {
		store.set("issue_new_comment_enabled", "false");
		store.set("issue_admin_link_in_comments_enabled", "false");
		store.set("admin_base_url", "http://host:6767/admin");
		expect(store.getBoolean("issue_new_comment_enabled")).toBe(false);
		expect(store.getBoolean("issue_admin_link_in_comments_enabled")).toBe(false);
		expect(store.get("admin_base_url")).toBe("http://host:6767/admin");
		const views = store.getAllViews();
		expect(views.find((v) => v.key === "issue_new_comment_enabled")?.category).toBe("issues");
		expect(views.find((v) => v.key === "admin_base_url")?.category).toBe("server");
	});

	it("round-trips the per-session model override settings", () => {
		store.set("pi_agent_build_model", "glm-build");
		store.set("pi_agent_refinement_model", "glm-refine");
		expect(store.get("pi_agent_build_model")).toBe("glm-build");
		expect(store.get("pi_agent_refinement_model")).toBe("glm-refine");
		const views = store.getAllViews();
		expect(views.find((v) => v.key === "pi_agent_build_model")).toMatchObject({
			value: "glm-build",
			category: "ai-llm",
			requiresRestart: false,
			sensitive: false,
		});
		expect(views.find((v) => v.key === "pi_agent_refinement_model")).toMatchObject({
			value: "glm-refine",
			category: "ai-llm",
			requiresRestart: false,
			sensitive: false,
		});
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
