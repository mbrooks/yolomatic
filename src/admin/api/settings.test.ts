import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fetchSettings, updateSettings } from "./settings.js";

function mockOkResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("settings API", () => {
	let fetchSpy: any;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			return mockOkResponse({});
		});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	describe("fetchSettings", () => {
		it("calls GET /api/settings and returns the settings array", async () => {
			fetchSpy.mockImplementation(async () =>
				mockOkResponse({
					settings: [
						{ key: "port", value: 8080, envSource: "database" },
						{ key: "github_token", value: "", envSource: "env" },
					],
				}),
			);
			const result = await fetchSettings();
			expect(result.settings).toHaveLength(2);
			expect(result.settings[1].envSource).toBe("env");
			const calls = fetchSpy.mock.calls as [string, RequestInit][];
			expect(calls[0][0]).toBe("/api/settings");
		});
	});

	describe("updateSettings", () => {
		it("PATCHes /api/settings and returns updated, requiresRestart, and ignored", async () => {
			fetchSpy.mockImplementation(async () =>
				mockOkResponse({
					updated: ["github_username"],
					requiresRestart: ["github_username"],
					ignored: ["github_token"],
				}),
			);
			const result = await updateSettings({ github_username: "new-bot" });
			expect(result).toEqual({
				updated: ["github_username"],
				requiresRestart: ["github_username"],
				ignored: ["github_token"],
			});
			const calls = fetchSpy.mock.calls as [string, RequestInit][];
			expect(calls[0][0]).toBe("/api/settings");
			expect(calls[0][1]?.method).toBe("PATCH");
			expect(JSON.parse(calls[0][1]?.body as string)).toEqual({ github_username: "new-bot" });
		});

		it("throws the error message from the response body", async () => {
			fetchSpy.mockImplementation(async () =>
				new Response(JSON.stringify({ error: "boom" }), {
					status: 400,
					statusText: "Bad Request",
					headers: { "content-type": "application/json" },
				}),
			);
			await expect(updateSettings({ port: 1 })).rejects.toThrow("boom");
		});

		it("falls back to statusText when the body has no error", async () => {
			fetchSpy.mockImplementation(async () =>
				new Response(JSON.stringify({}), {
					status: 500,
					statusText: "Internal Server Error",
					headers: { "content-type": "application/json" },
				}),
			);
			await expect(updateSettings({ port: 1 })).rejects.toThrow("Internal Server Error");
		});
	});
});