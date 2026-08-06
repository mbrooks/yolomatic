import { describe, expect, it } from "vitest";
import { buildAdminIssueUrl, resolveAdminIssueUrl, appendAdminLink, buildAdminSessionUrl, resolveAdminSessionUrl } from "./comment-links.js";

describe("buildAdminIssueUrl", () => {
	it("returns undefined when adminBaseUrl is undefined", () => {
		expect(buildAdminIssueUrl(undefined, "mbrooks", "yeetomatic", 1)).toBeUndefined();
	});

	it("returns undefined when adminBaseUrl is empty", () => {
		expect(buildAdminIssueUrl("", "mbrooks", "yeetomatic", 1)).toBeUndefined();
	});

	it("returns undefined when adminBaseUrl is whitespace", () => {
		expect(buildAdminIssueUrl("   ", "mbrooks", "yeetomatic", 1)).toBeUndefined();
	});

	it("builds a deep link for a non-empty base URL", () => {
		expect(buildAdminIssueUrl("http://host:6767/yeetomatic/admin", "mbrooks", "yeetomatic", 42)).toBe(
			"http://host:6767/yeetomatic/admin#/repos/mbrooks/yeetomatic/issues/42",
		);
	});

	it("trims whitespace and strips a trailing slash", () => {
		expect(buildAdminIssueUrl("  http://host:6767/admin/  ", "mbrooks", "yeetomatic", 7)).toBe(
			"http://host:6767/admin#/repos/mbrooks/yeetomatic/issues/7",
		);
	});

	it("preserves a root base URL", () => {
		expect(buildAdminIssueUrl("/", "mbrooks", "yeetomatic", 1)).toBe(
			"/#/repos/mbrooks/yeetomatic/issues/1",
		);
	});
});

describe("buildAdminSessionUrl", () => {
	it("returns undefined when adminBaseUrl is undefined", () => {
		expect(buildAdminSessionUrl(undefined, "mbrooks", "yeetomatic", 1, "refinement")).toBeUndefined();
	});

	it("returns undefined when adminBaseUrl is empty", () => {
		expect(buildAdminSessionUrl("", "mbrooks", "yeetomatic", 1, "implementation")).toBeUndefined();
	});

	it("returns undefined when adminBaseUrl is whitespace", () => {
		expect(buildAdminSessionUrl("   ", "mbrooks", "yeetomatic", 1, "refinement")).toBeUndefined();
	});

	it("builds a sessions-tab deep link for a refinement kind", () => {
		expect(buildAdminSessionUrl("http://host:6767/yeetomatic/admin", "mbrooks", "yeetomatic", 42, "refinement")).toBe(
			"http://host:6767/yeetomatic/admin#/repos/mbrooks/yeetomatic/42/refinement",
		);
	});

	it("builds a sessions-tab deep link for an implementation kind", () => {
		expect(buildAdminSessionUrl("http://host:6767/yeetomatic/admin", "mbrooks", "yeetomatic", 7, "implementation")).toBe(
			"http://host:6767/yeetomatic/admin#/repos/mbrooks/yeetomatic/7/implementation",
		);
	});

	it("trims whitespace and strips a trailing slash", () => {
		expect(buildAdminSessionUrl("  http://host:6767/admin/  ", "mbrooks", "yeetomatic", 7, "refinement")).toBe(
			"http://host:6767/admin#/repos/mbrooks/yeetomatic/7/refinement",
		);
	});

	it("preserves a root base URL", () => {
		expect(buildAdminSessionUrl("/", "mbrooks", "yeetomatic", 1, "implementation")).toBe(
			"/#/repos/mbrooks/yeetomatic/1/implementation",
		);
	});
});

describe("resolveAdminSessionUrl", () => {
	it("returns undefined when the toggle is disabled", () => {
		expect(
			resolveAdminSessionUrl("http://host:6767/admin", false, "mbrooks", "yeetomatic", 1, "implementation"),
		).toBeUndefined();
		expect(
			resolveAdminSessionUrl("http://host:6767/admin", false, "mbrooks", "yeetomatic", 1, "refinement"),
		).toBeUndefined();
	});

	it("returns undefined when adminBaseUrl is empty even with the toggle on", () => {
		expect(
			resolveAdminSessionUrl("", true, "mbrooks", "yeetomatic", 1, "implementation"),
		).toBeUndefined();
	});

	it("returns undefined when the toggle is undefined and no base URL is set", () => {
		expect(
			resolveAdminSessionUrl(undefined, undefined, "mbrooks", "yeetomatic", 1, "refinement"),
		).toBeUndefined();
	});

	it("builds the session link when the toggle is enabled (or undefined) and a base URL is set", () => {
		expect(
			resolveAdminSessionUrl("http://host:6767/admin", true, "mbrooks", "yeetomatic", 5, "implementation"),
		).toBe("http://host:6767/admin#/repos/mbrooks/yeetomatic/5/implementation");
		expect(
			resolveAdminSessionUrl("http://host:6767/admin", undefined, "mbrooks", "yeetomatic", 5, "refinement"),
		).toBe("http://host:6767/admin#/repos/mbrooks/yeetomatic/5/refinement");
	});
});

describe("resolveAdminIssueUrl", () => {
	it("returns undefined when the toggle is disabled", () => {
		expect(
			resolveAdminIssueUrl("http://host:6767/admin", false, "mbrooks", "yeetomatic", 1),
		).toBeUndefined();
	});

	it("returns undefined when adminBaseUrl is empty even with the toggle on", () => {
		expect(
			resolveAdminIssueUrl("", true, "mbrooks", "yeetomatic", 1),
		).toBeUndefined();
	});

	it("returns undefined when the toggle is undefined and no base URL is set", () => {
		expect(
			resolveAdminIssueUrl(undefined, undefined, "mbrooks", "yeetomatic", 1),
		).toBeUndefined();
	});

	it("builds the link when the toggle is enabled (or undefined) and a base URL is set", () => {
		expect(
			resolveAdminIssueUrl("http://host:6767/admin", true, "mbrooks", "yeetomatic", 5),
		).toBe("http://host:6767/admin#/repos/mbrooks/yeetomatic/issues/5");
		expect(
			resolveAdminIssueUrl("http://host:6767/admin", undefined, "mbrooks", "yeetomatic", 5),
		).toBe("http://host:6767/admin#/repos/mbrooks/yeetomatic/issues/5");
	});
});

describe("appendAdminLink", () => {
	it("returns the body unchanged when no URL is provided", () => {
		expect(appendAdminLink("Picked up by Yeetomatic.", undefined)).toBe("Picked up by Yeetomatic.");
	});

	it("appends a Track status footer when a URL is provided", () => {
		expect(appendAdminLink("Picked up by Yeetomatic.", "http://host/admin#/repos/o/r/issues/1")).toBe(
			"Picked up by Yeetomatic.\n\nTrack status: http://host/admin#/repos/o/r/issues/1",
		);
	});

	it("is idempotent for a body that already contains the footer", () => {
		const body = "Done.\n\nTrack status: http://host/admin#/repos/o/r/issues/1";
		expect(appendAdminLink(body, "http://host/admin#/repos/o/r/issues/1")).toBe(body);
	});
});