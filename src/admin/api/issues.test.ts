import { afterEach, describe, expect, it, vi } from "vitest";
import { chatIssue, createIssue, fetchRepoContext, generateIssue, fetchOpenIssues } from "./issues.js";

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

	it("creates issues via POST", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ number: 42, html_url: "http://issue/42" }),
		);

		await expect(
			createIssue({
				owner: "mbrooks",
				repo: "tars",
				title: "Bug report",
				body: "details",
				labels: ["bug"],
				assignees: ["mbrooks"],
			}),
		).resolves.toEqual({ number: 42, html_url: "http://issue/42" });

		expect(fetchSpy).toHaveBeenCalledWith("/api/issues", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				owner: "mbrooks",
				repo: "tars",
				title: "Bug report",
				body: "details",
				labels: ["bug"],
				assignees: ["mbrooks"],
			}),
		});
	});

	it("generates issue drafts via POST", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ title: "Generated", body: "Body", labels: ["bug"], assignees: [] }),
		);

		await expect(
			generateIssue({
				owner: "mbrooks",
				repo: "tars",
				prompt: "make an issue",
			}),
		).resolves.toEqual({
			title: "Generated",
			body: "Body",
			labels: ["bug"],
			assignees: [],
		});
	});

	it("sends issue chat payloads via POST", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				message: "Draft updated.",
				owner: "mbrooks",
				repo: "tars",
				draft: { title: "Generated", body: "Body", labels: ["bug"], assignees: [] },
				readyToCreate: true,
				shouldCreate: false,
			}),
		);

		await expect(
			chatIssue({
				owner: "mbrooks",
				repo: "tars",
				messages: [{ role: "user", text: "hello" }],
			}),
		).resolves.toMatchObject({
			message: "Draft updated.",
			owner: "mbrooks",
			repo: "tars",
			readyToCreate: true,
		});

		expect(fetchSpy).toHaveBeenCalledWith("/api/issues/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				owner: "mbrooks",
				repo: "tars",
				messages: [{ role: "user", text: "hello" }],
			}),
		});
	});

	it("fetches repo context via GET", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				labels: ["bug"],
				templates: [{ name: "Bug Report", body: "template" }],
				recentCommits: ["abc123"],
				relatedIssues: [{ number: 1, title: "Old", state: "open" }],
			}),
		);

		await expect(fetchRepoContext("mbrooks", "tars")).resolves.toEqual({
			labels: ["bug"],
			templates: [{ name: "Bug Report", body: "template" }],
			recentCommits: ["abc123"],
			relatedIssues: [{ number: 1, title: "Old", state: "open" }],
		});

		expect(fetchSpy).toHaveBeenCalledWith("/api/repos/mbrooks/tars/context");
	});

	it("fetches open issues via GET", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				issues: [
					{ number: 1, title: "Bug", body: "desc", state: "open", labels: ["bug"], assignees: ["mbrooks"], html_url: "https://github.com/mbrooks/tars/issues/1" },
				],
			}),
		);

		await expect(fetchOpenIssues("mbrooks", "tars")).resolves.toEqual([
			{ number: 1, title: "Bug", body: "desc", state: "open", labels: ["bug"], assignees: ["mbrooks"], html_url: "https://github.com/mbrooks/tars/issues/1" },
		]);

		expect(fetchSpy).toHaveBeenCalledWith("/api/repos/mbrooks/tars/issues");
	});
});
