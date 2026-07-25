import { describe, expect, it, vi } from "vitest";
import { addRepo, listAccessibleRepos, removeRepo, scanRepos } from "./repos.js";

global.fetch = vi.fn();

const mockedFetch = vi.mocked(fetch);

describe("addRepo", () => {
	it("returns add result on success", async () => {
		mockedFetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", added: true }),
		} as Response);

		const result = await addRepo("octocat", "hello-world");
		expect(result.added).toBe(true);
		expect(result.fullName).toBe("octocat/hello-world");
		expect(mockedFetch).toHaveBeenCalledWith("/api/repos", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ owner: "octocat", repo: "hello-world" }),
		});
	});

	it("throws when response is not ok", async () => {
		mockedFetch.mockResolvedValue({
			ok: false,
			status: 404,
			statusText: "Not Found",
			json: async () => ({ error: "Repository not found or not accessible" }),
		} as Response);

		await expect(addRepo("unknown", "missing")).rejects.toThrow("Repository not found or not accessible");
	});
});

describe("listAccessibleRepos", () => {
	it("returns accessible and configured repos on success", async () => {
		mockedFetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				repositories: [
					{ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", visibility: "public" },
				],
				configured: [{ owner: "octocat", repo: "hello-world" }],
			}),
		} as Response);

		const result = await listAccessibleRepos();
		expect(result.repositories).toHaveLength(1);
		expect(result.configured).toEqual([{ owner: "octocat", repo: "hello-world" }]);
		expect(mockedFetch).toHaveBeenCalledWith("/api/repos/accessible");
	});

	it("throws when response is not ok", async () => {
		mockedFetch.mockResolvedValue({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			json: async () => ({ error: "GitHub service not configured" }),
		} as Response);

		await expect(listAccessibleRepos()).rejects.toThrow("HTTP 500");
	});

	it("falls back to statusText when error body has no error field", async () => {
		mockedFetch.mockResolvedValue({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			json: async () => ({}),
		} as Response);

		await expect(listAccessibleRepos()).rejects.toThrow("HTTP 500");
	});
});

describe("scanRepos", () => {
	it("returns scan result on success", async () => {
		mockedFetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				repos: [{ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", visibility: "public" }],
				added: 0,
				skipped: [{ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", visibility: "public" }],
			}),
		} as Response);

		const result = await scanRepos();
		expect(result.repos).toHaveLength(1);
		expect(result.added).toBe(0);
		expect(result.skipped).toHaveLength(1);
		expect(mockedFetch).toHaveBeenCalledWith("/api/repos/scan", { method: "POST" });
	});

	it("throws when response is not ok", async () => {
		mockedFetch.mockResolvedValue({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			json: async () => ({ error: "Token invalid" }),
		} as Response);

		await expect(scanRepos()).rejects.toThrow("Token invalid");
	});

	it("falls back to statusText when error body has no error field", async () => {
		mockedFetch.mockResolvedValue({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			json: async () => ({}),
		} as Response);

		await expect(scanRepos()).rejects.toThrow("Internal Server Error");
	});
});

describe("removeRepo", () => {
	it("returns remove result on success", async () => {
		mockedFetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ removed: true }),
		} as Response);

		const result = await removeRepo("octocat", "hello-world");
		expect(result.removed).toBe(true);
		expect(mockedFetch).toHaveBeenCalledWith("/api/repos/octocat/hello-world", { method: "DELETE" });
	});

	it("throws when response is not ok", async () => {
		mockedFetch.mockResolvedValue({
			ok: false,
			status: 404,
			statusText: "Not Found",
			json: async () => ({ error: "Repository not configured" }),
		} as Response);

		await expect(removeRepo("unknown", "missing")).rejects.toThrow("Repository not configured");
	});

	it("falls back to statusText when error body has no error field", async () => {
		mockedFetch.mockResolvedValue({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			json: async () => ({}),
		} as Response);

		await expect(removeRepo("x", "y")).rejects.toThrow("Internal Server Error");
	});
});
