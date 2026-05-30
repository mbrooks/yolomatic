import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
	fetchServerSkills,
	createServerSkill,
	updateServerSkill,
	deleteServerSkill,
	fetchRepoSkills,
	createRepoSkill,
	updateRepoSkill,
	deleteRepoSkill,
} from "./skills.js";

describe("skills API", () => {
	beforeEach(() => {
		global.fetch = vi.fn();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function mockFetch(json: unknown, ok = true, status = 200) {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok,
			status,
			json: async () => json,
		} as unknown as Response);
	}

	it("fetchServerSkills returns skills", async () => {
		mockFetch({ skills: [{ id: "s1", name: "n", description: "", content: "", enabled: true, updatedAt: "", createdAt: "" }] });
		const result = await fetchServerSkills();
		expect(result.skills.length).toBe(1);
	});

	it("createServerSkill POSTs and returns skill", async () => {
		mockFetch({ id: "s1", name: "n", description: "", content: "", enabled: true, updatedAt: "", createdAt: "" });
		const result = await createServerSkill({ name: "n", description: "", content: "c", enabled: true });
		expect(result.name).toBe("n");
	});

	it("updateServerSkill PATCHes and returns skill", async () => {
		mockFetch({ id: "s1", name: "n2", description: "", content: "", enabled: true, updatedAt: "", createdAt: "" });
		const result = await updateServerSkill("s1", { name: "n2" });
		expect(result.name).toBe("n2");
	});

	it("updateServerSkill throws on error", async () => {
		mockFetch({ error: "bad" }, false, 500);
		await expect(updateServerSkill("s1", {})).rejects.toThrow("bad");
	});

	it("deleteServerSkill DELETEs", async () => {
		mockFetch({ deleted: true });
		const result = await deleteServerSkill("s1");
		expect(result.deleted).toBe(true);
	});

	it("deleteServerSkill throws on error", async () => {
		mockFetch({ error: "nope" }, false, 404);
		await expect(deleteServerSkill("s1")).rejects.toThrow("nope");
	});

	it("fetchRepoSkills returns skills", async () => {
		mockFetch({ skills: [{ name: "n", description: "", content: "", enabled: true, updatedAt: "", source: "repo" }] });
		const result = await fetchRepoSkills("o", "r");
		expect(result.skills.length).toBe(1);
	});

	it("createRepoSkill POSTs and returns skill", async () => {
		mockFetch({ name: "n", description: "", content: "", enabled: true, updatedAt: "", source: "repo" });
		const result = await createRepoSkill("o", "r", { name: "n", description: "", content: "c", enabled: true });
		expect(result.name).toBe("n");
	});

	it("updateRepoSkill PATCHes", async () => {
		mockFetch({ name: "n2" });
		const result = await updateRepoSkill("o", "r", "n", { name: "n2" });
		expect(result).toEqual({ name: "n2" });
	});

	it("updateRepoSkill throws on error", async () => {
		mockFetch({ error: "fail" }, false, 500);
		await expect(updateRepoSkill("o", "r", "n", {})).rejects.toThrow("fail");
	});

	it("deleteRepoSkill DELETEs", async () => {
		mockFetch({ deleted: true });
		const result = await deleteRepoSkill("o", "r", "n");
		expect(result.deleted).toBe(true);
	});

	it("deleteRepoSkill throws on error", async () => {
		mockFetch({ error: "missing" }, false, 404);
		await expect(deleteRepoSkill("o", "r", "n")).rejects.toThrow("missing");
	});

	it("throws on error with json parse failure for update", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: false,
			status: 403,
			statusText: "Forbidden",
			json: async () => { throw new Error("parse fail"); },
		} as unknown as Response);
		await expect(updateServerSkill("s1", {})).rejects.toThrow("Forbidden");
	});

	it("throws statusText when delete has no error body", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: false,
			status: 400,
			statusText: "Bad Request",
			json: async () => { throw new Error("fail"); },
		} as unknown as Response);
		await expect(deleteServerSkill("s1")).rejects.toThrow("Bad Request");
	});

	it("updateRepoSkill throws statusText on parse failure", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			json: async () => { throw new Error("fail"); },
		} as unknown as Response);
		await expect(updateRepoSkill("o", "r", "n", {})).rejects.toThrow("Internal Server Error");
	});

	it("deleteRepoSkill throws statusText on parse failure", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			json: async () => { throw new Error("fail"); },
		} as unknown as Response);
		await expect(deleteRepoSkill("o", "r", "n")).rejects.toThrow("Internal Server Error");
	});
});
