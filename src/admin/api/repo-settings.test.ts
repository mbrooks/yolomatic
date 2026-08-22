import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRepoSettings, updateRepoSettings } from "./repo-settings.js";

const fetchSpy = vi.fn();

vi.stubGlobal("fetch", fetchSpy);

describe("repo-settings api", () => {
	beforeEach(() => {
		fetchSpy.mockReset();
	});

	it("fetches repo settings", async () => {
		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ settings: [] }),
		});

		await expect(fetchRepoSettings("mbrooks", "yolomatic")).resolves.toEqual({ settings: [] });
		expect(fetchSpy).toHaveBeenCalledWith("/api/repos/mbrooks/yolomatic/settings");
	});

	it("updates repo settings", async () => {
		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ updated: ["github_event_mode"], requiresRestart: ["github_event_mode"] }),
		});

		await expect(updateRepoSettings("mbrooks", "yolomatic", { github_event_mode: "polling" })).resolves.toEqual({
			updated: ["github_event_mode"],
			requiresRestart: ["github_event_mode"],
		});
		expect(fetchSpy).toHaveBeenCalledWith(
			"/api/repos/mbrooks/yolomatic/settings",
			expect.objectContaining({
				method: "PATCH",
				body: JSON.stringify({ github_event_mode: "polling" }),
			}),
		);
	});

	it("surfaces API errors", async () => {
		fetchSpy.mockResolvedValue({
			ok: false,
			statusText: "Bad Request",
			json: async () => ({ error: "bad settings" }),
		});

		await expect(updateRepoSettings("mbrooks", "yolomatic", { github_event_mode: "bad" })).rejects.toThrow("bad settings");
	});

	it("sends a body-less PATCH when no body is supplied", async () => {
		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ updated: [], requiresRestart: [] }),
		});

		await expect(updateRepoSettings("mbrooks", "yolomatic", undefined as never)).resolves.toEqual({
			updated: [],
			requiresRestart: [],
		});
		expect(fetchSpy).toHaveBeenCalledWith(
			"/api/repos/mbrooks/yolomatic/settings",
			expect.not.objectContaining({ body: expect.anything(), headers: expect.anything() }),
		);
	});

	it("falls back to statusText when the error body is unparseable", async () => {
		fetchSpy.mockResolvedValue({
			ok: false,
			statusText: "Bad Request",
			json: async () => {
				throw new Error("parse error");
			},
		});

		await expect(updateRepoSettings("mbrooks", "yolomatic", { github_event_mode: "bad" })).rejects.toThrow("Bad Request");
	});
});
