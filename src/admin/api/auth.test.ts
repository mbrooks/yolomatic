import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./client.js", () => ({
	apiGet: vi.fn(),
	apiPost: vi.fn(),
}));

import { apiGet, apiPost } from "./client.js";
import { login, logout, fetchMe } from "./auth.js";

describe("auth api", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("login", () => {
		it("POSTs credentials to /api/login and returns the user", async () => {
			const user = {
				id: "u1",
				fullName: "Admin",
				username: "admin",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			};
			vi.mocked(apiPost).mockResolvedValueOnce({ user });

			const result = await login({ username: "admin", password: "secret" });

			expect(apiPost).toHaveBeenCalledWith("/api/login", { username: "admin", password: "secret" });
			expect(result).toEqual({ user });
		});
	});

	describe("logout", () => {
		it("POSTs to /api/logout and returns ok", async () => {
			vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });

			const result = await logout();

			expect(apiPost).toHaveBeenCalledWith("/api/logout");
			expect(result).toEqual({ ok: true });
		});
	});

	describe("fetchMe", () => {
		it("GETs /api/me and returns the user", async () => {
			const user = {
				id: "u1",
				fullName: "Admin",
				username: "admin",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			};
			vi.mocked(apiGet).mockResolvedValueOnce({ user });

			const result = await fetchMe();

			expect(apiGet).toHaveBeenCalledWith("/api/me");
			expect(result).toEqual({ user });
		});
	});
});