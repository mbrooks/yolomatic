import type { IncomingMessage, ServerResponse } from "node:http";
import { getSettingDefinition } from "../../../settings/model.js";
import { sendJson } from "../response-helpers.js";
import {
	AdminRouteRegistry,
	getRequiredDeps,
	type AdminRouterDeps,
} from "../admin-router-shared.js";

const registry = new AdminRouteRegistry()
	.route({
		method: "GET",
		pattern: /^\/api\/settings$/u,
		requiresDeps: ["settingsStore"],
		handler: async (ctx) => {
			const { settingsStore } = getRequiredDeps(ctx.deps, ["settingsStore"]);
			const settings = settingsStore.getAllViews();
			return { status: 200, body: { settings } };
		},
	})
	.route<Record<string, string | number | boolean>>({
		method: "PATCH",
		pattern: /^\/api\/settings$/u,
		parseBody: true,
		requiresDeps: ["settingsStore"],
		handler: async (ctx) => {
			const { settingsStore } = getRequiredDeps(ctx.deps, ["settingsStore"]);
			const body = ctx.body as Record<string, string | number | boolean>;
			const requiresRestart: string[] = [];
			const updated: string[] = [];
			for (const [key, value] of Object.entries(body)) {
				const definition = getSettingDefinition(key);
				if (definition?.sensitive && value === "") {
					continue;
				}
				settingsStore.setTyped(key, value);
				if (definition?.requiresRestart) {
					requiresRestart.push(key);
				}
				updated.push(key);
			}
			return { status: 200, body: { updated, requiresRestart } };
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/github\/invitations$/u,
		requiresDeps: ["githubService"],
		handler: async (ctx) => {
			const { githubService } = getRequiredDeps(ctx.deps, ["githubService"]);
			const invitations = await githubService.listPendingInvitations();
			return { status: 200, body: { invitations } };
		},
	})
	.route({
		method: "POST",
		pattern: /^\/api\/github\/invitations\/([^/]+)\/accept$/u,
		requiresDeps: ["githubService"],
		handler: async (ctx) => {
			const { githubService } = getRequiredDeps(ctx.deps, ["githubService"]);
			const invitationId = Number.parseInt(ctx.params[0], 10);
			if (Number.isNaN(invitationId)) {
				sendJson(ctx.response, 400, { error: "Invalid invitation ID" });
				return;
			}
			await githubService.acceptInvitation(invitationId);
			return { status: 200, body: { accepted: true } };
		},
	});

export async function handleSettingsRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	pathname: string,
): Promise<boolean> {
	return registry.handle(request, response, deps, pathname);
}
