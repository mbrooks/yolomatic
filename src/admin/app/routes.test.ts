// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { parseHash, buildHash, navigate, useRoute, DEFAULT_SETTINGS_TAB, getDefaultAdminPage } from "./routes.js";

describe("getDefaultAdminPage", () => {
	afterEach(() => {
		delete (window as unknown as { __YEETOMATIC_ADMIN_DEFAULT_PAGE__?: string }).__YEETOMATIC_ADMIN_DEFAULT_PAGE__;
		window.location.hash = "";
	});

	it("returns #/dashboard when no override is configured", () => {
		expect(getDefaultAdminPage()).toBe("#/dashboard");
	});

	it("returns the configured override", () => {
		(window as unknown as { __YEETOMATIC_ADMIN_DEFAULT_PAGE__: string }).__YEETOMATIC_ADMIN_DEFAULT_PAGE__ = "#/repos";
		expect(getDefaultAdminPage()).toBe("#/repos");
	});

	it("falls back to #/dashboard for an empty override", () => {
		(window as unknown as { __YEETOMATIC_ADMIN_DEFAULT_PAGE__: string }).__YEETOMATIC_ADMIN_DEFAULT_PAGE__ = "";
		expect(getDefaultAdminPage()).toBe("#/dashboard");
	});
});

describe("useRoute default page", () => {
	afterEach(() => {
		delete (window as unknown as { __YEETOMATIC_ADMIN_DEFAULT_PAGE__?: string }).__YEETOMATIC_ADMIN_DEFAULT_PAGE__;
		window.location.hash = "";
	});

	it("navigates to the configured default page when the hash is empty", async () => {
		(window as unknown as { __YEETOMATIC_ADMIN_DEFAULT_PAGE__: string }).__YEETOMATIC_ADMIN_DEFAULT_PAGE__ = "#/repos";
		window.location.hash = "";
		const { unmount } = renderHook(() => useRoute());
		await new Promise((r) => setTimeout(r, 0));
		expect(window.location.hash).toBe("#/repos");
		expect(parseHash(window.location.hash)).toEqual({ screen: "repos" });
		unmount();
	});
});

describe("navigate", () => {
	beforeEach(() => {
		window.location.hash = "#/dashboard";
	});

	afterEach(() => {
		window.location.hash = "";
	});

	it("sets window.location.hash", () => {
		navigate({ screen: "settings", tab: DEFAULT_SETTINGS_TAB });
		expect(window.location.hash).toBe(`#/settings/${DEFAULT_SETTINGS_TAB}`);
	});
});

describe("useRoute", () => {
	beforeEach(() => {
		window.location.hash = "#/repos/mbrooks/yeetomatic";
	});

	afterEach(() => {
		window.location.hash = "";
	});

	it("returns current route from hash", () => {
		const { result } = renderHook(() => useRoute());
		expect(result.current).toEqual(expect.objectContaining({ screen: "repo", owner: "mbrooks", repo: "yeetomatic" }));
	});
});

describe("parseHash", () => {
	it("parses dashboard list", () => {
		expect(parseHash("#/dashboard")).toEqual({ screen: "dashboard" });
	});

	it("parses repos list", () => {
		expect(parseHash("#/repos")).toEqual({ screen: "repos" });
	});

	it("parses repo detail (default tab)", () => {
		expect(parseHash("#/repos/mbrooks/yeetomatic")).toEqual({
			screen: "repo",
			owner: "mbrooks",
			repo: "yeetomatic",
			issueNumber: undefined,
			tab: "sessions",
		});
	});

	it("parses repo detail (sessions tab)", () => {
		expect(parseHash("#/repos/mbrooks/yeetomatic/sessions")).toEqual({
			screen: "repo",
			owner: "mbrooks",
			repo: "yeetomatic",
			issueNumber: undefined,
			tab: "sessions",
		});
	});

	it("parses repo detail with issue number", () => {
		expect(parseHash("#/repos/mbrooks/yeetomatic/140")).toEqual({
			screen: "repo",
			owner: "mbrooks",
			repo: "yeetomatic",
			issueNumber: 140,
			tab: "sessions",
		});
	});

	it("parses repo detail with sessions tab and issue number", () => {
		expect(parseHash("#/repos/mbrooks/yeetomatic/sessions/140")).toEqual({
			screen: "repo",
			owner: "mbrooks",
			repo: "yeetomatic",
			issueNumber: 140,
			tab: "sessions",
		});
	});

	it("parses repo detail with skills tab and issue number", () => {
		expect(parseHash("#/repos/mbrooks/yeetomatic/skills/140")).toEqual({
			screen: "repo",
			owner: "mbrooks",
			repo: "yeetomatic",
			issueNumber: 140,
			tab: "skills",
		});
	});

	it("parses working view", () => {
		expect(parseHash("#/working")).toEqual({ screen: "working" });
	});

	it("parses new-issue view", () => {
		expect(parseHash("#/new-issue")).toEqual({ screen: "new-issue" });
	});

	it("parses new-issue view with owner and repo", () => {
		expect(parseHash("#/new-issue/mbrooks/yeetomatic")).toEqual({ screen: "new-issue", owner: "mbrooks", repo: "yeetomatic" });
	});

	it("defaults to dashboard for unknown", () => {
		expect(parseHash("")).toEqual({ screen: "dashboard" });
	});

	it("parses repo detail (issues tab)", () => {
		expect(parseHash("#/repos/mbrooks/yeetomatic/issues")).toEqual({
			screen: "repo",
			owner: "mbrooks",
			repo: "yeetomatic",
			issueNumber: undefined,
			tab: "issues",
		});
	});

	it("parses repo detail (settings tab)", () => {
		expect(parseHash("#/repos/mbrooks/yeetomatic/settings")).toEqual({
			screen: "repo",
			owner: "mbrooks",
			repo: "yeetomatic",
			issueNumber: undefined,
			tab: "settings",
		});
	});

	it("parses settings view with default category tab", () => {
		expect(parseHash("#/settings")).toEqual({ screen: "settings", tab: DEFAULT_SETTINGS_TAB });
		expect(DEFAULT_SETTINGS_TAB).toBe("server");
	});

	it("parses settings view with category tab", () => {
		expect(parseHash("#/settings/ai-llm")).toEqual({ screen: "settings", tab: "ai-llm" });
	});

	it("parses server-skills view", () => {
		expect(parseHash("#/settings/skills")).toEqual({ screen: "settings", tab: "skills" });
	});

	it("parses invitations view", () => {
		expect(parseHash("#/settings/invitations")).toEqual({ screen: "settings", tab: "invitations" });
	});

	it("defaults settings tab to first category for unknown slug", () => {
		expect(parseHash("#/settings/unknown")).toEqual({ screen: "settings", tab: DEFAULT_SETTINGS_TAB });
	});
});

describe("buildHash", () => {
	it("builds dashboard view", () => {
		expect(buildHash({ screen: "dashboard" })).toBe("#/dashboard");
	});

	it("builds repos list", () => {
		expect(buildHash({ screen: "repos" })).toBe("#/repos");
	});

	it("builds new-issue view", () => {
		expect(buildHash({ screen: "new-issue" })).toBe("#/new-issue");
	});

	it("builds repo detail (sessions default)", () => {
		expect(
			buildHash({ screen: "repo", owner: "mbrooks", repo: "yeetomatic", issueNumber: undefined, tab: "sessions" }),
		).toBe("#/repos/mbrooks/yeetomatic");
	});

	it("builds repo detail with issues tab", () => {
		expect(
			buildHash({ screen: "repo", owner: "mbrooks", repo: "yeetomatic", issueNumber: undefined, tab: "issues" }),
		).toBe("#/repos/mbrooks/yeetomatic/issues");
	});

	it("builds repo detail with explicit sessions tab", () => {
		expect(
			buildHash({ screen: "repo", owner: "mbrooks", repo: "yeetomatic", issueNumber: undefined, tab: "sessions" }),
		).toBe("#/repos/mbrooks/yeetomatic");
	});

	it("builds repo detail with issue number (sessions default)", () => {
		expect(
			buildHash({ screen: "repo", owner: "mbrooks", repo: "yeetomatic", issueNumber: 140, tab: "sessions" }),
		).toBe("#/repos/mbrooks/yeetomatic/140");
	});

	it("builds repo detail with issues tab and issue number", () => {
		expect(
			buildHash({ screen: "repo", owner: "mbrooks", repo: "yeetomatic", issueNumber: 140, tab: "issues" }),
		).toBe("#/repos/mbrooks/yeetomatic/issues/140");
	});

	it("builds repo detail with skills tab and issue number", () => {
		expect(
			buildHash({ screen: "repo", owner: "mbrooks", repo: "yeetomatic", issueNumber: 140, tab: "skills" }),
		).toBe("#/repos/mbrooks/yeetomatic/skills/140");
	});

	it("builds new-issue view with owner and repo", () => {
		expect(buildHash({ screen: "new-issue", owner: "mbrooks", repo: "yeetomatic" })).toBe("#/new-issue/mbrooks/yeetomatic");
	});

	it("round-trips issues tab", () => {
		const hash = buildHash({ screen: "repo" as const, owner: "mbrooks", repo: "yeetomatic", issueNumber: undefined, tab: "issues" as const });
		expect(parseHash(hash)).toEqual(expect.objectContaining({ screen: "repo", tab: "issues" }));
	});

	it("builds repo detail with skills tab", () => {
		expect(
			buildHash({ screen: "repo", owner: "mbrooks", repo: "yeetomatic", issueNumber: undefined, tab: "skills" }),
		).toBe("#/repos/mbrooks/yeetomatic/skills");
	});

	it("builds repo detail with settings tab", () => {
		expect(
			buildHash({ screen: "repo", owner: "mbrooks", repo: "yeetomatic", issueNumber: undefined, tab: "settings" }),
		).toBe("#/repos/mbrooks/yeetomatic/settings");
	});

	it("builds settings root", () => {
		expect(buildHash({ screen: "settings" })).toBe("#/settings");
	});

	it("builds server-skills view", () => {
		expect(buildHash({ screen: "settings", tab: "skills" })).toBe("#/settings/skills");
	});

	it("builds settings category tab view", () => {
		expect(buildHash({ screen: "settings", tab: "git-worktrees" })).toBe("#/settings/git-worktrees");
	});

	it("round-trips skills tab", () => {
		const hash = buildHash({ screen: "repo" as const, owner: "mbrooks", repo: "yeetomatic", issueNumber: undefined, tab: "skills" as const });
		expect(parseHash(hash)).toEqual(expect.objectContaining({ screen: "repo", tab: "skills" }));
	});

	it("round-trips settings tab", () => {
		const hash = buildHash({ screen: "repo" as const, owner: "mbrooks", repo: "yeetomatic", issueNumber: undefined, tab: "settings" as const });
		expect(parseHash(hash)).toEqual(expect.objectContaining({ screen: "repo", tab: "settings" }));
	});

	it("round-trips sessions tab with issue number", () => {
		const hash = buildHash({ screen: "repo" as const, owner: "mbrooks", repo: "yeetomatic", issueNumber: 140, tab: "sessions" as const });
		expect(parseHash(hash)).toEqual(expect.objectContaining({ screen: "repo", tab: "sessions", issueNumber: 140 }));
	});

	it("round-trips skills tab with issue number", () => {
		const hash = buildHash({ screen: "repo" as const, owner: "mbrooks", repo: "yeetomatic", issueNumber: 140, tab: "skills" as const });
		expect(parseHash(hash)).toEqual(expect.objectContaining({ screen: "repo", tab: "skills", issueNumber: 140 }));
	});

	it("builds invitations view", () => {
		expect(buildHash({ screen: "settings", tab: "invitations" })).toBe("#/settings/invitations");
	});

	it("round-trips invitations tab", () => {
		const hash = buildHash({ screen: "settings" as const, tab: "invitations" as const });
		expect(parseHash(hash)).toEqual(expect.objectContaining({ screen: "settings", tab: "invitations" }));
	});

	it("round-trips settings category tab", () => {
		const hash = buildHash({ screen: "settings" as const, tab: "git-worktrees" as const });
		expect(parseHash(hash)).toEqual(expect.objectContaining({ screen: "settings", tab: "git-worktrees" }));
	});

	it("round-trips repositories settings tab", () => {
		const hash = buildHash({ screen: "settings" as const, tab: "repositories" as const });
		expect(parseHash(hash)).toEqual(expect.objectContaining({ screen: "settings", tab: "repositories" }));
	});

	it("routes removed settings category tabs to Server", () => {
		for (const tab of ["authentication", "file-system", "logging"]) {
			expect(parseHash(`#/settings/${tab}`)).toEqual({ screen: "settings", tab: "server" });
		}
	});

});
