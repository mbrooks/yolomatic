import { describe, expect, it, vi } from "vitest";
import {
	mapResultToStatus,
	mergeRepoAndServerSkills,
	getCredentials,
	checkAdminJson,
	checkAdminTextAllowOnboarding,
} from "./admin-router-shared.js";

vi.mock("./admin-auth.js", () => ({
	requireAdminJson: vi.fn(() => true),
	requireAdminText: vi.fn(() => true),
}));

describe("admin-router-shared", () => {
	it("maps unknown result codes to 500", () => {
		expect(mapResultToStatus("unexpected")).toBe(500);
	});

	it("maps known result codes", () => {
		expect(mapResultToStatus("not_found")).toBe(404);
		expect(mapResultToStatus("invalid_state")).toBe(400);
		expect(mapResultToStatus("unauthorized")).toBe(401);
		expect(mapResultToStatus("conflict")).toBe(409);
	});

	it("returns credentials from adminUsername/adminPassword when set", () => {
		const result = getCredentials({
			adminUsername: "admin",
			adminPassword: "secret",
		} as never);
		expect(result).toEqual({ username: "admin", password: "secret" });
	});

	it("returns credentials from settingsStore when admin credentials are not set", () => {
		const result = getCredentials({
			settingsStore: {
				get: (key: string) => (key === "admin_username" ? "stored-admin" : key === "admin_password" ? "stored-secret" : undefined),
			},
		} as never);
		expect(result).toEqual({ username: "stored-admin", password: "stored-secret" });
	});

	it("returns empty credentials when nothing is set", () => {
		const result = getCredentials({} as never);
		expect(result).toEqual({});
	});

	it("checkAdminJson returns false when credentials are missing", () => {
		const request = { headers: {} } as never;
		const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() } as never;
		const result = checkAdminJson(request, response, {} as never);
		expect(result).toBe(false);
	});

	it("checkAdminJson returns result from requireAdminJson when credentials exist", () => {
		const request = { headers: {} } as never;
		const response = { statusCode: 0 } as never;
		const result = checkAdminJson(request, response, {
			adminUsername: "admin",
			adminPassword: "secret",
		} as never);
		expect(result).toBe(true);
	});

	it("checkAdminTextAllowOnboarding returns true when credentials are missing", () => {
		const request = { headers: {} } as never;
		const response = { statusCode: 0 } as never;
		const result = checkAdminTextAllowOnboarding(request, response, {} as never);
		expect(result).toBe(true);
	});

	it("checkAdminTextAllowOnboarding returns result from requireAdminText when credentials exist", () => {
		const request = { headers: {} } as never;
		const response = { statusCode: 0 } as never;
		const result = checkAdminTextAllowOnboarding(request, response, {
			adminUsername: "admin",
			adminPassword: "secret",
		} as never);
		expect(result).toBe(true);
	});

	it("merges repo and server skills with repo overrides", () => {
		const merged = mergeRepoAndServerSkills(
			[
				{
					name: "repo-only",
					description: "repo",
					content: "repo",
					enabled: true,
					updatedAt: "2025-01-01T00:00:00Z",
					source: "repo",
				},
				{
					name: "shared",
					description: "repo override",
					content: "repo content",
					enabled: false,
					updatedAt: "2025-01-02T00:00:00Z",
					source: "repo",
				},
			],
			[
				{
					id: "1",
					name: "shared",
					description: "server",
					content: "server",
					enabled: true,
					updatedAt: "2025-01-01T00:00:00Z",
					createdAt: "2025-01-01T00:00:00Z",
				},
				{
					id: "2",
					name: "inherited",
					description: "server only",
					content: "server only",
					enabled: true,
					updatedAt: "2025-01-01T00:00:00Z",
					createdAt: "2025-01-01T00:00:00Z",
				},
			],
		);

		expect(merged.map((skill) => [skill.name, skill.source])).toEqual([
			["inherited", "inherited"],
			["repo-only", "repo"],
			["shared", "repo"],
		]);
	});
});
