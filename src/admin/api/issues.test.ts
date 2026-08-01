import { afterEach, describe, expect, it, vi } from "vitest";
import { assignIssue, closeIssue, fetchOpenIssues, markIssueDoNotWork, startIssueSession } from "./issues.js";

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("issues api", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fetches open issues via GET", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				issues: [
					{ number: 1, title: "Bug", body: "desc", state: "open", labels: ["bug"], assignees: ["mbrooks"], html_url: "https://github.com/mbrooks/yeetomatic/issues/1" },
				],
			}),
		);

		await expect(fetchOpenIssues("mbrooks", "yeetomatic")).resolves.toEqual([
			{ number: 1, title: "Bug", body: "desc", state: "open", labels: ["bug"], assignees: ["mbrooks"], html_url: "https://github.com/mbrooks/yeetomatic/issues/1" },
		]);

		expect(fetchSpy).toHaveBeenCalledWith("/api/repos/mbrooks/yeetomatic/issues");
	});

	it("assigns issue via POST", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ started: true, status: "working", message: "ok" }),
		);

		await expect(assignIssue("mbrooks", "yeetomatic", 42, "Bug", "desc", ["bug"])).resolves.toEqual({ started: true, status: "working", message: "ok" });

		expect(fetchSpy).toHaveBeenCalledWith("/api/repos/mbrooks/yeetomatic/issues/42/assign", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] }),
		});
	});

	it("starts issue session via POST", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ started: true, status: "working", message: "ok" }),
		);

		await expect(startIssueSession("mbrooks", "yeetomatic", 42, "Bug", "desc", ["bug"])).resolves.toEqual({
			started: true,
			status: "working",
			message: "ok",
		});

		expect(fetchSpy).toHaveBeenCalledWith("/api/repos/mbrooks/yeetomatic/issues/42/start-session", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Bug", body: "desc", labels: ["bug"] }),
		});
	});

	it("closes issue via POST", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ closed: true }),
		);

		await expect(closeIssue("mbrooks", "yeetomatic", 42)).resolves.toEqual({ closed: true });

		expect(fetchSpy).toHaveBeenCalledWith("/api/repos/mbrooks/yeetomatic/issues/42/close", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
	});

	it("marks issue as do-not-work via POST", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ closed: true, labeled: true }),
		);

		await expect(markIssueDoNotWork("mbrooks", "yeetomatic", 42)).resolves.toEqual({ closed: true, labeled: true });

		expect(fetchSpy).toHaveBeenCalledWith("/api/repos/mbrooks/yeetomatic/issues/42/mark-do-not-work", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
	});
});
