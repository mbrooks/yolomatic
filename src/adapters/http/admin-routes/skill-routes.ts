import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../response-helpers.js";
import {
	AdminRouteRegistry,
	NotFoundError,
	getRequiredDeps,
	type AdminRouterDeps,
} from "../admin-router-shared.js";
import { mergeRepoAndServerSkills } from "../../../skills/merge-skills.js";

const registry = new AdminRouteRegistry()
	.route({
		method: "GET",
		pattern: /^\/api\/skills$/u,
		requiresDeps: ["skillStore"],
		handler: async (ctx) => {
			const { skillStore } = getRequiredDeps(ctx.deps, ["skillStore"]);
			const skills = await skillStore.listAll();
			return { status: 200, body: { skills } };
		},
	})
	.route<{
		name?: string;
		description?: string;
		content?: string;
	}>({
		method: "POST",
		pattern: /^\/api\/skills$/u,
		parseBody: true,
		required: ["name", "content"],
		requiresDeps: ["skillStore"],
		handler: async (ctx) => {
			const { skillStore } = getRequiredDeps(ctx.deps, ["skillStore"]);
			const body = ctx.body as {
				name: string;
				description?: string;
				content: string;
			};
			const skill = await skillStore.create({
				name: body.name,
				description: body.description || "",
				content: body.content,
			});
			return { status: 201, body: skill };
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/skills\/([^/]+)$/u,
		requiresDeps: ["skillStore"],
		handler: async (ctx) => {
			const { skillStore } = getRequiredDeps(ctx.deps, ["skillStore"]);
			const [id] = ctx.params;
			const skill = await skillStore.get(id);
			if (!skill) {
				throw new NotFoundError("Skill not found");
			}
			return { status: 200, body: skill };
		},
	})
	.route<Partial<{
		name: string;
		description: string;
		content: string;
	}>>({
		method: "PATCH",
		pattern: /^\/api\/skills\/([^/]+)$/u,
		parseBody: true,
		requiresDeps: ["skillStore"],
		handler: async (ctx) => {
			const { skillStore } = getRequiredDeps(ctx.deps, ["skillStore"]);
			const [id] = ctx.params;
			const body = ctx.body as Partial<{
				name: string;
				description: string;
				content: string;
			}>;
			try {
				const updated = await skillStore.update(id, body);
				if (!updated) {
					throw new NotFoundError("Skill not found");
				}
				return { status: 200, body: updated };
			} catch (error) {
				if (error instanceof NotFoundError) {
					throw error;
				}
				const message = error instanceof Error ? error.message : String(error);
				sendJson(ctx.response, 400, { error: message });
				return;
			}
		},
	})
	.route({
		method: "DELETE",
		pattern: /^\/api\/skills\/([^/]+)$/u,
		requiresDeps: ["skillStore"],
		handler: async (ctx) => {
			const { skillStore } = getRequiredDeps(ctx.deps, ["skillStore"]);
			const [id] = ctx.params;
			await skillStore.delete(id);
			return { status: 200, body: { deleted: true } };
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/skills$/u,
		requiresDeps: ["repoSkillService"],
		handler: async (ctx) => {
			const { repoSkillService } = getRequiredDeps(ctx.deps, ["repoSkillService"]);
			const [owner, repo] = ctx.params;
			const repoSkills = await repoSkillService.listRepoSkills(owner, repo);
			const serverSkills = ctx.deps.skillStore ? await ctx.deps.skillStore.listAll() : [];
			return { status: 200, body: { skills: mergeRepoAndServerSkills(repoSkills, serverSkills) } };
		},
	})
	.route<{
		name?: string;
		description?: string;
		content?: string;
	}>({
		method: "POST",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/skills$/u,
		parseBody: true,
		required: ["name", "content"],
		requiresDeps: ["repoSkillService"],
		handler: async (ctx) => {
			const { repoSkillService } = getRequiredDeps(ctx.deps, ["repoSkillService"]);
			const [owner, repo] = ctx.params;
			const body = ctx.body as {
				name: string;
				description?: string;
				content: string;
			};
			const result = await repoSkillService.saveRepoSkill(owner, repo, {
				name: body.name,
				description: body.description || "",
				content: body.content,
			});
			if (!result.success) {
				sendJson(ctx.response, 500, { error: result.error || "Failed to save skill" });
				return;
			}
			const updated = await repoSkillService.listRepoSkills(owner, repo);
			const found = updated.find((skill) => skill.name === body.name);
			return { status: 201, body: found ?? { name: body.name } };
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/skills\/([^/]+)$/u,
		requiresDeps: ["repoSkillService"],
		handler: async (ctx) => {
			const { repoSkillService } = getRequiredDeps(ctx.deps, ["repoSkillService"]);
			const [owner, repo, name] = ctx.params;
			const skill = await repoSkillService.getRepoSkill(owner, repo, name);
			if (!skill) {
				throw new NotFoundError("Skill not found");
			}
			return { status: 200, body: skill };
		},
	})
	.route<Partial<{
		name: string;
		description: string;
		content: string;
	}>>({
		method: "PATCH",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/skills\/([^/]+)$/u,
		parseBody: true,
		requiresDeps: ["repoSkillService"],
		handler: async (ctx) => {
			const { repoSkillService } = getRequiredDeps(ctx.deps, ["repoSkillService"]);
			const [owner, repo, name] = ctx.params;
			const body = ctx.body as Partial<{
				name: string;
				description: string;
				content: string;
			}>;
			try {
				const existing = await repoSkillService.getRepoSkill(owner, repo, name);
				if (!existing) {
					throw new NotFoundError("Skill not found");
				}
				if (body.name !== undefined && body.name !== name) {
					await repoSkillService.deleteRepoSkill(owner, repo, name);
				}
				const result = await repoSkillService.saveRepoSkill(owner, repo, {
					name: body.name ?? name,
					description: body.description ?? existing.description,
					content: body.content ?? existing.content,
				});
				if (!result.success) {
					sendJson(ctx.response, 500, { error: result.error || "Failed to save skill" });
					return;
				}
				return { status: 200, body: { name: body.name ?? name } };
			} catch (error) {
				if (error instanceof NotFoundError) {
					throw error;
				}
				const message = error instanceof Error ? error.message : String(error);
				sendJson(ctx.response, 400, { error: message });
				return;
			}
		},
	})
	.route({
		method: "DELETE",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/skills\/([^/]+)$/u,
		requiresDeps: ["repoSkillService"],
		handler: async (ctx) => {
			const { repoSkillService } = getRequiredDeps(ctx.deps, ["repoSkillService"]);
			const [owner, repo, name] = ctx.params;
			const result = await repoSkillService.deleteRepoSkill(owner, repo, name);
			if (!result.success) {
				sendJson(ctx.response, 500, { error: result.error || "Failed to delete skill" });
				return;
			}
			return { status: 200, body: { deleted: true } };
		},
	});

export async function handleSkillRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	pathname: string,
): Promise<boolean> {
	return registry.handle(request, response, deps, pathname);
}
