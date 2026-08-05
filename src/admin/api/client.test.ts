import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { apiDelete, apiGet, apiPatch, apiPost } from "./client.js";

describe("client", () => {
	beforeEach(() => {
		global.fetch = vi.fn();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function mockFetch(response: Partial<Response>) {
		vi.mocked(fetch).mockResolvedValueOnce(response as Response);
	}

	it("apiGet returns JSON on success", async () => {
		mockFetch({ ok: true, status: 200, json: async () => ({ foo: "bar" }) });
		const result = await apiGet("/api/foo");
		expect(result).toEqual({ foo: "bar" });
		expect(fetch).toHaveBeenCalledWith("/api/foo");
	});

	it("apiGet throws HTTP status on error", async () => {
		mockFetch({ ok: false, status: 404, statusText: "Not Found", json: async () => ({}) });
		await expect(apiGet("/api/foo")).rejects.toThrow("HTTP 404");
	});

	it("apiPost sends body and returns JSON", async () => {
		mockFetch({ ok: true, status: 200, json: async () => ({ created: true }) });
		const result = await apiPost("/api/foo", { name: "x" });
		expect(result).toEqual({ created: true });
		expect(fetch).toHaveBeenCalledWith("/api/foo", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "x" }),
		});
	});

	it("apiPost throws error message from body", async () => {
		mockFetch({ ok: false, status: 400, statusText: "Bad Request", json: async () => ({ error: "bad" }) });
		await expect(apiPost("/api/foo", {})).rejects.toThrow("bad");
	});

	it("apiDelete sends DELETE and returns JSON", async () => {
		mockFetch({ ok: true, status: 200, json: async () => ({ removed: true }) });
		const result = await apiDelete("/api/foo");
		expect(result).toEqual({ removed: true });
		expect(fetch).toHaveBeenCalledWith("/api/foo", { method: "DELETE" });
	});

	it("apiDelete throws error message from body", async () => {
		mockFetch({ ok: false, status: 404, statusText: "Not Found", json: async () => ({ error: "missing" }) });
		await expect(apiDelete("/api/foo")).rejects.toThrow("missing");
	});

	it("apiDelete falls back to statusText when body has no error", async () => {
		mockFetch({ ok: false, status: 500, statusText: "Internal Server Error", json: async () => ({}) });
		await expect(apiDelete("/api/foo")).rejects.toThrow("Internal Server Error");
	});

	it("apiPatch sends body and returns JSON", async () => {
		mockFetch({ ok: true, status: 200, json: async () => ({ updated: true }) });
		const result = await apiPatch("/api/foo", { name: "y" });
		expect(result).toEqual({ updated: true });
		expect(fetch).toHaveBeenCalledWith("/api/foo", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "y" }),
		});
	});

	it("apiPatch sends no body when undefined", async () => {
		mockFetch({ ok: true, status: 200, json: async () => ({ ok: true }) });
		const result = await apiPatch("/api/foo");
		expect(result).toEqual({ ok: true });
		expect(fetch).toHaveBeenCalledWith("/api/foo", { method: "PATCH" });
	});

	it("apiPatch throws error message from body", async () => {
		mockFetch({ ok: false, status: 400, statusText: "Bad Request", json: async () => ({ error: "bad patch" }) });
		await expect(apiPatch("/api/foo", {})).rejects.toThrow("bad patch");
	});

	it("apiPatch falls back to statusText when body has no error", async () => {
		mockFetch({ ok: false, status: 500, statusText: "Internal Server Error", json: async () => ({}) });
		await expect(apiPatch("/api/foo")).rejects.toThrow("Internal Server Error");
	});
});
