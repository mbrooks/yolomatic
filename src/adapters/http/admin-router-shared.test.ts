import { describe, expect, it, vi } from "vitest";
import {
	AdminRouteRegistry,
	type AdminRouteContext,
	mapResultToStatus,
	mergeRepoAndServerSkills,
	getCredentials,
	checkAdminJson,
	checkAdminTextAllowOnboarding,
	requireDeps,
} from "./admin-router-shared.js";

vi.mock("./admin-auth.js", () => ({
	requireAdminJson: vi.fn(() => true),
	requireAdminText: vi.fn(() => true),
}));

describe("admin-router-shared", () => {
	function mockResponse() {
		const res = {
			statusCode: 0,
			body: "",
			setHeader: vi.fn(),
			end: vi.fn((data?: string) => {
				res.body = data ?? "";
			}),
		} as {
			statusCode: number;
			body: string;
			setHeader: ReturnType<typeof vi.fn>;
			end: ReturnType<typeof vi.fn>;
		};
		return res;
	}

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
					updatedAt: "2025-01-01T00:00:00Z",
					source: "repo",
				},
				{
					name: "shared",
					description: "repo override",
					content: "repo content",
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
					updatedAt: "2025-01-01T00:00:00Z",
					createdAt: "2025-01-01T00:00:00Z",
				},
				{
					id: "2",
					name: "inherited",
					description: "server only",
					content: "server only",
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

	it("requireDeps sends the configured dependency error response", () => {
		const response = mockResponse();
		const ctx = {
			request: { headers: {} },
			response,
			deps: {},
			body: {},
			params: [],
		} as unknown as AdminRouteContext;

		const ok = requireDeps(ctx, ["settingsStore"]);

		expect(ok).toBe(false);
		expect(response.statusCode).toBe(500);
		expect(JSON.parse(response.body).error).toBe("Settings store not configured");
	});

	it("registry handles missing route deps before invoking the handler", async () => {
		const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));
		const registry = new AdminRouteRegistry().route({
			method: "GET",
			pattern: /^\/api\/settings$/u,
			auth: false,
			requiresDeps: ["settingsStore"],
			handler,
		});
		const response = mockResponse();

		const handled = await registry.handle(
			{ method: "GET", url: "/api/settings", headers: {} } as never,
			response as never,
			{} as never,
			"/api/settings",
		);

		expect(handled).toBe(true);
		expect(response.statusCode).toBe(500);
		expect(JSON.parse(response.body).error).toBe("Settings store not configured");
		expect(handler).not.toHaveBeenCalled();
	});
});
