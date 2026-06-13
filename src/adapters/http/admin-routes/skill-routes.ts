import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../../../webhook/http-utils.js";
import { sendJson } from "../response-helpers.js";
import {
	checkAdminJson,
	mergeRepoAndServerSkills,
	type AdminRouterDeps,
} from "../admin-router-shared.js";

export async function handleSkillRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	pathname: string,
): Promise<boolean> {
	if (pathname === "/api/skills") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.skillStore) {
			sendJson(response, 500, { error: "Skill store not configured" });
			return true;
		}

		if (request.method === "GET") {
			try {
				const skills = await deps.skillStore.listAll();
				sendJson(response, 200, { skills });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: message });
			}
			return true;
		}

		if (request.method === "POST") {
			try {
				const body = JSON.parse((await readBody(request)).toString("utf8")) as {
					name?: string;
					description?: string;
					content?: string;
				};
				if (!body.name || !body.content) {
					sendJson(response, 400, { error: "Missing required fields: name, content" });
					return true;
				}
				const skill = await deps.skillStore.create({
					name: body.name,
					description: body.description || "",
					content: body.content,
				});
				sendJson(response, 201, skill);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 400, { error: message });
			}
			return true;
		}
	}

	const serverSkillDetailMatch = /^\/api\/skills\/([^/]+)$/u.exec(pathname);
	if (serverSkillDetailMatch && request.method === "GET") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.skillStore) {
			sendJson(response, 500, { error: "Skill store not configured" });
			return true;
		}
		const [, id] = serverSkillDetailMatch;
		try {
			const skill = await deps.skillStore.get(id);
			if (!skill) {
				sendJson(response, 404, { error: "Skill not found" });
				return true;
			}
			sendJson(response, 200, skill);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	if (serverSkillDetailMatch && request.method === "PATCH") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.skillStore) {
			sendJson(response, 500, { error: "Skill store not configured" });
			return true;
		}
		const [, id] = serverSkillDetailMatch;
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as Partial<{
				name: string;
				description: string;
				content: string;
			}>;
			const updated = await deps.skillStore.update(id, body);
			if (!updated) {
				sendJson(response, 404, { error: "Skill not found" });
				return true;
			}
			sendJson(response, 200, updated);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 400, { error: message });
		}
		return true;
	}

	if (serverSkillDetailMatch && request.method === "DELETE") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.skillStore) {
			sendJson(response, 500, { error: "Skill store not configured" });
			return true;
		}
		const [, id] = serverSkillDetailMatch;
		try {
			await deps.skillStore.delete(id);
			sendJson(response, 200, { deleted: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	const repoSkillsMatch = /^\/api\/repos\/([^/]+)\/([^/]+)\/skills$/u.exec(pathname);
	if (repoSkillsMatch && request.method === "GET") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.repoSkillService) {
			sendJson(response, 500, { error: "Repo skill service not configured" });
			return true;
		}
		const [, owner, repo] = repoSkillsMatch;
		try {
			const repoSkills = await deps.repoSkillService.listRepoSkills(owner, repo);
			const serverSkills = deps.skillStore ? await deps.skillStore.listAll() : [];
			sendJson(response, 200, {
				skills: mergeRepoAndServerSkills(repoSkills, serverSkills),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	if (repoSkillsMatch && request.method === "POST") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.repoSkillService) {
			sendJson(response, 500, { error: "Repo skill service not configured" });
			return true;
		}
		const [, owner, repo] = repoSkillsMatch;
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as {
				name?: string;
				description?: string;
				content?: string;
			};
			if (!body.name || !body.content) {
				sendJson(response, 400, { error: "Missing required fields: name, content" });
				return true;
			}
			const result = await deps.repoSkillService.saveRepoSkill(owner, repo, {
				name: body.name,
				description: body.description || "",
				content: body.content,
			});
			if (!result.success) {
				sendJson(response, 500, { error: result.error || "Failed to save skill" });
				return true;
			}
			const updated = await deps.repoSkillService.listRepoSkills(owner, repo);
			const found = updated.find((skill) => skill.name === body.name);
			sendJson(response, 201, found ?? { name: body.name });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 400, { error: message });
		}
		return true;
	}

	const repoSkillDetailMatch =
		/^\/api\/repos\/([^/]+)\/([^/]+)\/skills\/([^/]+)$/u.exec(pathname);
	if (repoSkillDetailMatch && request.method === "GET") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.repoSkillService) {
			sendJson(response, 500, { error: "Repo skill service not configured" });
			return true;
		}
		const [, owner, repo, name] = repoSkillDetailMatch;
		try {
			const skill = await deps.repoSkillService.getRepoSkill(owner, repo, name);
			if (!skill) {
				sendJson(response, 404, { error: "Skill not found" });
				return true;
			}
			sendJson(response, 200, skill);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	if (repoSkillDetailMatch && request.method === "PATCH") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.repoSkillService) {
			sendJson(response, 500, { error: "Repo skill service not configured" });
			return true;
		}
		const [, owner, repo, name] = repoSkillDetailMatch;
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as Partial<{
				name: string;
				description: string;
				content: string;
			}>;
			const existing = await deps.repoSkillService.getRepoSkill(owner, repo, name);
			if (!existing) {
				sendJson(response, 404, { error: "Skill not found" });
				return true;
			}
			if (body.name !== undefined && body.name !== name) {
				await deps.repoSkillService.deleteRepoSkill(owner, repo, name);
			}
			const result = await deps.repoSkillService.saveRepoSkill(owner, repo, {
				name: body.name ?? name,
				description: body.description ?? existing.description,
				content: body.content ?? existing.content,
			});
			if (!result.success) {
				sendJson(response, 500, { error: result.error || "Failed to save skill" });
				return true;
			}
			sendJson(response, 200, { name: body.name ?? name });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 400, { error: message });
		}
		return true;
	}

	if (repoSkillDetailMatch && request.method === "DELETE") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.repoSkillService) {
			sendJson(response, 500, { error: "Repo skill service not configured" });
			return true;
		}
		const [, owner, repo, name] = repoSkillDetailMatch;
		try {
			const result = await deps.repoSkillService.deleteRepoSkill(owner, repo, name);
			if (!result.success) {
				sendJson(response, 500, { error: result.error || "Failed to delete skill" });
				return true;
			}
			sendJson(response, 200, { deleted: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	return false;
}
