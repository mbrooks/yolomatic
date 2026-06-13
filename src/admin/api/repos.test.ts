import { describe, expect, it, vi } from "vitest";
import { scanRepos } from "./repos.js";

global.fetch = vi.fn();

const mockedFetch = vi.mocked(fetch);

describe("scanRepos", () => {
	it("returns scan result on success", async () => {
		mockedFetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ repos: [{ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" }], added: 1 }),
		} as Response);

		const result = await scanRepos();
		expect(result.repos).toHaveLength(1);
		expect(result.added).toBe(1);
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
