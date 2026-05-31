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

	it("returns 404 when repo skill patch targets a missing skill", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request(
				"/api/repos/mbrooks/tars/skills/triage",
				"PATCH",
				JSON.stringify({ description: "Updated" }),
			),
			res,
			{
				adminUsername: "admin",
				adminPassword: "secret",
				repoSkillService: {
					getRepoSkill: vi.fn(async () => null),
				},
			} as never,
			"/api/repos/mbrooks/tars/skills/triage",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(404);
	});

	it("renames a repo skill before saving the replacement", async () => {
		const res = response();
		const deleteRepoSkill = vi.fn(async () => ({ success: true }));
		const saveRepoSkill = vi.fn(async () => ({ success: true }));
		const handled = await handleSkillRoutes(
			request(
				"/api/repos/mbrooks/tars/skills/triage",
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
						enabled: true,
						updatedAt: "",
						source: "repo",
					})),
					deleteRepoSkill,
					saveRepoSkill,
				},
			} as never,
			"/api/repos/mbrooks/tars/skills/triage",
		);

		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		expect(deleteRepoSkill).toHaveBeenCalledWith("mbrooks", "tars", "triage");
		expect(saveRepoSkill).toHaveBeenCalledWith("mbrooks", "tars", {
			name: "triage-v2",
			description: "Existing",
			content: "Body",
			enabled: true,
		});
	});

	it("returns 500 when server skill patch is requested without a skill store", async () => {
		const res = response();
		const handled = await handleSkillRoutes(
			request("/api/skills/skill-1", "PATCH", JSON.stringify({ enabled: false })),
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
