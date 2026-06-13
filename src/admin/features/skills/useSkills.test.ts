// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useServerSkills, useRepoSkills } from "./useSkills.js";

describe("useServerSkills", () => {
	let fetchSpy: any;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ skills: [{ id: "1", name: "a", description: "", content: "", updatedAt: "", createdAt: "" }] }),
		} as Response));
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("loads skills on mount", async () => {
		const { result } = renderHook(() => useServerSkills());
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(result.current.skills.length).toBe(1);
		expect(result.current.loading).toBe(false);
		expect(result.current.error).toBeNull();
	});

	it("handles errors", async () => {
		fetchSpy.mockImplementation(async () => ({
			ok: false,
			status: 500,
			json: async () => ({ error: "network" }),
		} as Response));
		const { result } = renderHook(() => useServerSkills());
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(result.current.loading).toBe(false);
		expect(result.current.error).toContain("500");
	});
});

describe("useRepoSkills", () => {
	let fetchSpy: any;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ skills: [{ name: "a", description: "", content: "", updatedAt: "", source: "repo" }] }),
		} as Response));
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("loads repo skills on mount", async () => {
		const { result } = renderHook(() => useRepoSkills("o", "r"));
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(result.current.skills.length).toBe(1);
		expect(result.current.loading).toBe(false);
	});
});
