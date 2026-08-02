import { describe, expect, it } from "vitest";
import { buildAdminIssueUrl, resolveAdminIssueUrl, appendAdminLink } from "./comment-links.js";

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