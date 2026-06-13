// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRepoContext } from "./useRepoContext.js";

function mockJsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("useRepoContext", () => {
	let fetchSpy: any;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/skills")) {
				return mockJsonResponse({ skills: [] });
			}
			return mockJsonResponse({
				labels: ["bug"],
				templates: [{ name: "Bug", body: "body" }],
				recentCommits: [],
				relatedIssues: [],
			});
		});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("loads repo context and skills for an owner and repo", async () => {
		const { result } = renderHook(() => useRepoContext("mbrooks", "tars"));

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("/api/repos/mbrooks/tars/context"));
		expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("/api/repos/mbrooks/tars/skills"));
		expect(result.current.loadingContext).toBe(false);
		expect(result.current.loadingSkills).toBe(false);
		expect(result.current.repoContext?.labels).toEqual(["bug"]);
		expect(result.current.skills).toEqual([]);
	});

	it("clears context and selected template", async () => {
		const { result } = renderHook(() => useRepoContext("mbrooks", "tars"));

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		act(() => {
			result.current.setSelectedTemplate("Bug");
			result.current.clearRepoContext();
		});

		expect(result.current.repoContext).toBeNull();
		expect(result.current.selectedTemplate).toBeUndefined();
	});

	it("does not load context without a complete repo", () => {
		const { result } = renderHook(() => useRepoContext("", "tars"));

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(result.current.repoContext).toBeNull();
	});
});
