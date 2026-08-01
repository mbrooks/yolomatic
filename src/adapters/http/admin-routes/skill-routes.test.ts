import { describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { handleSkillRoutes } from "./skill-routes.js";

function request(url: string, method = "GET", body?: string): http.IncomingMessage {
	const chunks = body ? [Buffer.from(body)] : [];
	return {
		method,
		url,
		headers: {
			authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
		},
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) {
				yield chunk;
			}
		},
	} as http.IncomingMessage;
}

function response() {
	const res = {
		statusCode: 0,
		body: "",
		setHeader: vi.fn(),
		end: vi.fn((data?: string) => {
			res.body = data ?? "";
		}),
	} as unknown as http.ServerResponse & { body: string; statusCode: number };
	return res;
}

describe("handleSkillRoutes", () => {
	it("returns false for unrelated paths", async () => {
		const handled = await handleSkillRoutes(
			request("/api/other"),
			response(),
			{} as never,
			"/api/other",
		);
		expect(handled).toBe(false);
	});

	it("GET /api/skills lists server skills", async () => {
		const res = response();
		const listAll = vi.fn(async () => [
			{ id: "s1", name: "a", description: "", content: "", updatedAt: "", createdAt: "" },
		]);
		const handled = await handleSkillRoutes(
			request("/api/skills"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				skillStore: { listAll },
			} as never,
			"/api/skills",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).skills.length).toBe(1);
	});

	it("POST /api/skills creates a server skill", async () => {
		const res = response();
		const create = vi.fn(async () => ({
			id: "s1", name: "n", description: "", content: "", updatedAt: "", createdAt: ""
		}));
		const handled = await handleSkillRoutes(
			request("/api/skills", "POST", JSON.stringify({ name: "n", content: "c" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				skillStore: { create },
			} as never,
			"/api/skills",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(201);
		expect(create).toHaveBeenCalledWith({ name: "n", description: "", content: "c" });
	});

	it("POST /api/skills returns 400 when missing required fields", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/skills", "POST", JSON.stringify({ name: "n" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				skillStore: { create: vi.fn() },
			} as never,
			"/api/skills",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});

	it("GET /api/skills/:id returns a server skill", async () => {
		const res = response();
		const get = vi.fn(async () => ({
			id: "s1", name: "a", description: "", content: "", updatedAt: "", createdAt: ""
		}));
		const handled = await handleSkillRoutes(
			request("/api/skills/s1"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				skillStore: { get },
			} as never,
			"/api/skills/s1",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
	});

	it("GET /api/skills/:id returns 404 for missing skill", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/skills/s1"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				skillStore: { get: vi.fn(async () => null) },
			} as never,
			"/api/skills/s1",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("PATCH /api/skills/:id updates a server skill", async () => {
		const res = response();
		const update = vi.fn(async () => ({
			id: "s1", name: "n2", description: "", content: "", updatedAt: "", createdAt: ""
		}));
		const handled = await handleSkillRoutes(
			request("/api/skills/s1", "PATCH", JSON.stringify({ name: "n2" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				skillStore: { update },
			} as never,
			"/api/skills/s1",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(update).toHaveBeenCalledWith("s1", { name: "n2" });
	});

	it("PATCH /api/skills/:id returns 404 for missing skill", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/skills/s1", "PATCH", JSON.stringify({ name: "n2" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				skillStore: { update: vi.fn(async () => null) },
			} as never,
			"/api/skills/s1",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("DELETE /api/skills/:id deletes a server skill", async () => {
		const res = response();
		const deleteSkill = vi.fn(async () => true);
		const handled = await handleSkillRoutes(
			request("/api/skills/s1", "DELETE"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				skillStore: { delete: deleteSkill },
			} as never,
			"/api/skills/s1",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).deleted).toBe(true);
	});

	it("GET /api/repos/:owner/:repo/skills returns 500 without repo skill service", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("GET /api/repos/:owner/:repo/skills lists repo skills", async () => {
		const res = response();
		const listRepoSkills = vi.fn(async () => [
			{ name: "a", description: "", content: "", updatedAt: "", source: "repo" as const },
		]);
		const listAll = vi.fn(async () => []);
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: { listRepoSkills },
				skillStore: { listAll },
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).skills.length).toBe(1);
	});

	it("POST /api/repos/:owner/:repo/skills creates a repo skill", async () => {
		const res = response();
		const saveRepoSkill = vi.fn(async () => ({ success: true }));
		const listRepoSkills = vi.fn(async () => [
			{ name: "n", description: "", content: "", updatedAt: "", source: "repo" as const },
		]);
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills", "POST", JSON.stringify({ name: "n", content: "c" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: { saveRepoSkill, listRepoSkills },
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(201);
		expect(saveRepoSkill).toHaveBeenCalledWith("mbrooks", "yeetomatic", { name: "n", description: "", content: "c" });
	});

	it("POST /api/repos/:owner/:repo/skills returns 400 when missing required fields", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills", "POST", JSON.stringify({ name: "n" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: { saveRepoSkill: vi.fn() },
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});

	it("POST /api/repos/:owner/:repo/skills returns 500 on save failure", async () => {
		const res = response();
		const saveRepoSkill = vi.fn(async () => ({ success: false, error: "fail" }));
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills", "POST", JSON.stringify({ name: "n", content: "c" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: { saveRepoSkill, listRepoSkills: vi.fn(async () => []) },
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("GET /api/repos/:owner/:repo/skills/:name returns a repo skill", async () => {
		const res = response();
		const getRepoSkill = vi.fn(async () => ({
			name: "found",
			description: "Desc",
			content: "Body",
			updatedAt: "",
			source: "repo" as const,
		}));
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills/found"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: { getRepoSkill },
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills/found",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).name).toBe("found");
	});

	it("GET /api/repos/:owner/:repo/skills/:name returns 404 for missing skill", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills/missing"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: { getRepoSkill: vi.fn(async () => null) },
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills/missing",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("PATCH /api/repos/:owner/:repo/skills/:name returns 404 for missing skill", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills/triage", "PATCH", JSON.stringify({ description: "Updated" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: {
					getRepoSkill: vi.fn(async () => null),
				},
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills/triage",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("PATCH /api/repos/:owner/:repo/skills/:name returns 500 on save failure", async () => {
		const res = response();
		const saveRepoSkill = vi.fn(async () => ({ success: false, error: "fail" }));
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills/triage", "PATCH", JSON.stringify({ description: "Updated" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: {
					getRepoSkill: vi.fn(async () => ({
						name: "triage",
						description: "Existing",
						content: "Body",
						updatedAt: "",
						source: "repo",
					})),
					saveRepoSkill,
				},
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills/triage",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("renames a repo skill before saving the replacement", async () => {
		const res = response();
		const deleteRepoSkill = vi.fn(async () => ({ success: true }));
		const saveRepoSkill = vi.fn(async () => ({ success: true }));
		const handled = await handleSkillRoutes(
			request(
				"/api/repos/mbrooks/yeetomatic/skills/triage",
				"PATCH",
				JSON.stringify({ name: "triage-v2" }),
			),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: {
					getRepoSkill: vi.fn(async () => ({
						name: "triage",
						description: "Existing",
						content: "Body",
						updatedAt: "",
						source: "repo",
					})),
					deleteRepoSkill,
					saveRepoSkill,
				},
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills/triage",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(deleteRepoSkill).toHaveBeenCalledWith("mbrooks", "yeetomatic", "triage");
		expect(saveRepoSkill).toHaveBeenCalledWith("mbrooks", "yeetomatic", {
			name: "triage-v2",
			description: "Existing",
			content: "Body",
		});
	});

	it("DELETE /api/repos/:owner/:repo/skills/:name deletes a repo skill", async () => {
		const res = response();
		const deleteRepoSkill = vi.fn(async () => ({ success: true }));
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills/old", "DELETE"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: { deleteRepoSkill },
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills/old",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).deleted).toBe(true);
	});

	it("DELETE /api/repos/:owner/:repo/skills/:name returns 500 on delete failure", async () => {
		const res = response();
		const deleteRepoSkill = vi.fn(async () => ({ success: false, error: "fail" }));
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills/old", "DELETE"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: { deleteRepoSkill },
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills/old",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("returns 500 when server skill patch is requested without a skill store", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/skills/skill-1", "PATCH", JSON.stringify({ name: "x" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/skills/skill-1",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});
});

// Error case tests to increase branch coverage

describe("handleSkillRoutes error cases", () => {
	it("GET /api/skills returns 500 on listAll error", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/skills"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				skillStore: { listAll: vi.fn(async () => { throw new Error("db fail"); }) },
			} as never,
			"/api/skills",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.body).error).toBe("db fail");
	});

	it("POST /api/skills returns 400 on invalid JSON", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/skills", "POST", "not-json"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				skillStore: { create: vi.fn() },
			} as never,
			"/api/skills",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});

	it("GET /api/skills/:id returns 500 on get error", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/skills/s1"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				skillStore: { get: vi.fn(async () => { throw new Error("db fail"); }) },
			} as never,
			"/api/skills/s1",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.body).error).toBe("db fail");
	});

	it("PATCH /api/skills/:id returns 400 on invalid JSON", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/skills/s1", "PATCH", "not-json"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				skillStore: { update: vi.fn() },
			} as never,
			"/api/skills/s1",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});

	it("DELETE /api/skills/:id returns 500 on delete error", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/skills/s1", "DELETE"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				skillStore: { delete: vi.fn(async () => { throw new Error("db fail"); }) },
			} as never,
			"/api/skills/s1",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.body).error).toBe("db fail");
	});

	it("GET /api/repos/:owner/:repo/skills returns 500 on listRepoSkills error", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: { listRepoSkills: vi.fn(async () => { throw new Error("git fail"); }) },
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.body).error).toBe("git fail");
	});

	it("POST /api/repos/:owner/:repo/skills returns 400 on invalid JSON", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills", "POST", "not-json"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: { saveRepoSkill: vi.fn() },
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});

	it("GET /api/repos/:owner/:repo/skills/:name returns 500 on getRepoSkill error", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills/found"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: { getRepoSkill: vi.fn(async () => { throw new Error("git fail"); }) },
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills/found",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.body).error).toBe("git fail");
	});

	it("PATCH /api/repos/:owner/:repo/skills/:name returns 400 on invalid JSON", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills/triage", "PATCH", "not-json"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: { getRepoSkill: vi.fn() },
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills/triage",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});

	it("DELETE /api/repos/:owner/:repo/skills/:name returns 500 on deleteRepoSkill error", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills/old", "DELETE"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: { deleteRepoSkill: vi.fn(async () => { throw new Error("git fail"); }) },
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills/old",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.body).error).toBe("git fail");
	});
});

// Missing service branches

describe("handleSkillRoutes missing service branches", () => {
	it("GET /api/skills returns 500 without skill store", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/skills"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/skills",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("POST /api/skills returns 500 without skill store", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/skills", "POST", JSON.stringify({ name: "n", content: "c" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/skills",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("GET /api/skills/:id returns 500 without skill store", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/skills/s1"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/skills/s1",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("DELETE /api/skills/:id returns 500 without skill store", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/skills/s1", "DELETE"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/skills/s1",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("POST /api/repos/:owner/:repo/skills returns 500 without repo skill service", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills", "POST", JSON.stringify({ name: "n", content: "c" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("GET /api/repos/:owner/:repo/skills/:name returns 500 without repo skill service", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills/found"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills/found",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("PATCH /api/repos/:owner/:repo/skills/:name returns 500 without repo skill service", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills/triage", "PATCH", JSON.stringify({ description: "Updated" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills/triage",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});

	it("DELETE /api/repos/:owner/:repo/skills/:name returns 500 without repo skill service", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills/old", "DELETE"),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills/old",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(500);
	});
});

// Additional branch coverage

describe("handleSkillRoutes additional branches", () => {
	it("GET /api/skills returns 503 when in onboarding mode", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/skills"),
			res,
			{} as never,
			"/api/skills",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(503);
	});

	it("POST /api/skills returns 400 when content is missing", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/skills", "POST", JSON.stringify({ name: "n", description: "d" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				skillStore: { create: vi.fn() },
			} as never,
			"/api/skills",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(400);
	});

	it("PATCH /api/repos/:owner/:repo/skills/:name with same name does not delete", async () => {
		const res = response();
		const deleteRepoSkill = vi.fn(async () => ({ success: true }));
		const saveRepoSkill = vi.fn(async () => ({ success: true }));
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills/triage", "PATCH", JSON.stringify({ name: "triage" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: {
					getRepoSkill: vi.fn(async () => ({
						name: "triage",
						description: "Existing",
						content: "Body",
						updatedAt: "",
						source: "repo",
					})),
					deleteRepoSkill,
					saveRepoSkill,
				},
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills/triage",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(deleteRepoSkill).not.toHaveBeenCalled();
		expect(saveRepoSkill).toHaveBeenCalledWith("mbrooks", "yeetomatic", {
			name: "triage",
			description: "Existing",
			content: "Body",
		});
	});
});

describe("handleSkillRoutes final coverage", () => {
	it("POST /api/repos/:owner/:repo/skills returns skill name when not found in list", async () => {
		const res = response();
		const saveRepoSkill = vi.fn(async () => ({ success: true }));
		const listRepoSkills = vi.fn(async () => []);
		const handled = await handleSkillRoutes(
			request("/api/repos/mbrooks/yeetomatic/skills", "POST", JSON.stringify({ name: "n", content: "c" })),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: { saveRepoSkill, listRepoSkills },
			} as never,
			"/api/repos/mbrooks/yeetomatic/skills",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(201);
		expect(JSON.parse(res.body).name).toBe("n");
	});

	it("GET /api/skills/:id returns 503 when in onboarding mode", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/skills/s1"),
			res,
			{} as never,
			"/api/skills/s1",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(503);
	});

	it("DELETE /api/skills/:id returns 503 when in onboarding mode", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/skills/s1", "DELETE"),
			res,
			{} as never,
			"/api/skills/s1",
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(503);
	});
});
