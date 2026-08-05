import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./client.js", () => ({
	apiGet: vi.fn(),
	apiPost: vi.fn(),
	apiPatch: vi.fn(),
	apiDelete: vi.fn(),
}));

import { apiGet, apiPost, apiPatch, apiDelete } from "./client.js";
import {
	listUsers,
	createUser,
	updateUserFullName,
	resetUserPassword,
	deleteUser,
} from "./users.js";

describe("users api", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("listUsers", () => {
		it("GETs /api/users", async () => {
			const users = [
				{
					id: "u1",
					fullName: "Admin",
					username: "admin",
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
				},
			];
			vi.mocked(apiGet).mockResolvedValueOnce({ users });

			const result = await listUsers();

			expect(apiGet).toHaveBeenCalledWith("/api/users");
			expect(result).toEqual({ users });
		});
	});

	describe("createUser", () => {
		it("POSTs the create body to /api/users", async () => {
			const created = {
				id: "u2",
				fullName: "Jane Doe",
				username: "jane",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			};
			vi.mocked(apiPost).mockResolvedValueOnce(created);

			const result = await createUser({
				full_name: "Jane Doe",
				username: "jane",
				password: "p@ss",
			});

			expect(apiPost).toHaveBeenCalledWith("/api/users", {
				full_name: "Jane Doe",
				username: "jane",
				password: "p@ss",
			});
			expect(result).toEqual(created);
		});
	});

	describe("updateUserFullName", () => {
		it("PATCHes the full name to the user endpoint", async () => {
			const updated = {
				id: "u2",
				fullName: "Jane Smith",
				username: "jane",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-02T00:00:00Z",
			};
			vi.mocked(apiPatch).mockResolvedValueOnce(updated);

			const result = await updateUserFullName("u2", { full_name: "Jane Smith" });

			expect(apiPatch).toHaveBeenCalledWith("/api/users/u2", { full_name: "Jane Smith" });
			expect(result).toEqual(updated);
		});

		it("URL-encodes the user id", async () => {
			vi.mocked(apiPatch).mockResolvedValueOnce({
				id: "a/b",
				fullName: "X",
				username: "x",
				createdAt: "",
				updatedAt: "",
			});

			await updateUserFullName("a/b", { full_name: "X" });

			expect(apiPatch).toHaveBeenCalledWith("/api/users/a%2Fb", { full_name: "X" });
		});
	});

	describe("resetUserPassword", () => {
		it("POSTs the new password to the password endpoint", async () => {
			const updated = {
				id: "u2",
				fullName: "Jane",
				username: "jane",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-03T00:00:00Z",
			};
			vi.mocked(apiPost).mockResolvedValueOnce(updated);

			const result = await resetUserPassword("u2", { password: "new-p@ss" });

			expect(apiPost).toHaveBeenCalledWith("/api/users/u2/password", { password: "new-p@ss" });
			expect(result).toEqual(updated);
		});

		it("URL-encodes the user id", async () => {
			vi.mocked(apiPost).mockResolvedValueOnce({
				id: "a b",
				fullName: "X",
				username: "x",
				createdAt: "",
				updatedAt: "",
			});

			await resetUserPassword("a b", { password: "p" });

			expect(apiPost).toHaveBeenCalledWith("/api/users/a%20b/password", { password: "p" });
		});
	});

	describe("deleteUser", () => {
		it("DELETEs the user endpoint", async () => {
			vi.mocked(apiDelete).mockResolvedValueOnce({ deleted: true });

			const result = await deleteUser("u2");

			expect(apiDelete).toHaveBeenCalledWith("/api/users/u2");
			expect(result).toEqual({ deleted: true });
		});

		it("URL-encodes the user id", async () => {
			vi.mocked(apiDelete).mockResolvedValueOnce({ deleted: true });

			await deleteUser("a/b");

			expect(apiDelete).toHaveBeenCalledWith("/api/users/a%2Fb");
		});
	});
});