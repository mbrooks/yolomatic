import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../../../webhook/http-utils.js";
import { getSettingDefinition } from "../../../settings/model.js";
import { sendJson } from "../response-helpers.js";
import {
	checkAdminJson,
	type AdminRouterDeps,
} from "../admin-router-shared.js";

export async function handleSettingsRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	pathname: string,
): Promise<boolean> {
	if (pathname === "/api/settings") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.settingsStore) {
			sendJson(response, 500, { error: "Settings store not configured" });
			return true;
		}

		if (request.method === "GET") {
			try {
				const settings = deps.settingsStore.getAllViews();
				sendJson(response, 200, { settings });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: message });
			}
			return true;
		}

		if (request.method === "PATCH") {
			try {
				const body = JSON.parse((await readBody(request)).toString("utf8")) as Record<
					string,
					string | number | boolean
				>;
				const requiresRestart: string[] = [];
				const updated: string[] = [];
				for (const [key, value] of Object.entries(body)) {
					const definition = getSettingDefinition(key);
					if (definition?.sensitive && value === "") {
						continue;
					}
					deps.settingsStore.setTyped(key, value);
					if (definition?.requiresRestart) {
						requiresRestart.push(key);
					}
					updated.push(key);
				}
				sendJson(response, 200, { updated, requiresRestart });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 400, { error: message });
			}
			return true;
		}
	}

	if (pathname === "/api/github/invitations" && request.method === "GET") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.githubService) {
			sendJson(response, 500, { error: "GitHub service not configured" });
			return true;
		}
		try {
			const invitations = await deps.githubService.listPendingInvitations();
			sendJson(response, 200, { invitations });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	const acceptInvitationMatch =
		/^\/api\/github\/invitations\/([^/]+)\/accept$/u.exec(pathname);
	if (acceptInvitationMatch && request.method === "POST") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.githubService) {
			sendJson(response, 500, { error: "GitHub service not configured" });
			return true;
		}
		const invitationId = Number.parseInt(acceptInvitationMatch[1], 10);
		if (Number.isNaN(invitationId)) {
			sendJson(response, 400, { error: "Invalid invitation ID" });
			return true;
		}
		try {
			await deps.githubService.acceptInvitation(invitationId);
			sendJson(response, 200, { accepted: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	return false;
}
