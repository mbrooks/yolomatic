import type { IncomingMessage, ServerResponse } from "node:http";
import { getSettingDefinition } from "../../../settings/model.js";
import { sendJson } from "../response-helpers.js";
import {
	AdminRouteRegistry,
	type AdminRouterDeps,
} from "../admin-router-shared.js";

const registry = new AdminRouteRegistry()
	.route({
		method: "GET",
		pattern: /^\/api\/settings$/u,
		handler: async (ctx) => {
			if (!ctx.deps.settingsStore) {
				sendJson(ctx.response, 500, { error: "Settings store not configured" });
				return;
			}
			const settings = ctx.deps.settingsStore.getAllViews();
			return { status: 200, body: { settings } };
		},
	})
	.route<Record<string, string | number | boolean>>({
		method: "PATCH",
		pattern: /^\/api\/settings$/u,
		parseBody: true,
		handler: async (ctx) => {
			if (!ctx.deps.settingsStore) {
				sendJson(ctx.response, 500, { error: "Settings store not configured" });
				return;
			}
			const body = ctx.body as Record<string, string | number | boolean>;
			const requiresRestart: string[] = [];
			const updated: string[] = [];
			for (const [key, value] of Object.entries(body)) {
				const definition = getSettingDefinition(key);
				if (definition?.sensitive && value === "") {
					continue;
				}
				ctx.deps.settingsStore.setTyped(key, value);
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
		handler: async (ctx) => {
			if (!ctx.deps.githubService) {
				sendJson(ctx.response, 500, { error: "GitHub service not configured" });
				return;
			}
			const invitations = await ctx.deps.githubService.listPendingInvitations();
			return { status: 200, body: { invitations } };
		},
	})
	.route({
		method: "POST",
		pattern: /^\/api\/github\/invitations\/([^/]+)\/accept$/u,
		handler: async (ctx) => {
			if (!ctx.deps.githubService) {
				sendJson(ctx.response, 500, { error: "GitHub service not configured" });
				return;
			}
			const invitationId = Number.parseInt(ctx.params[0], 10);
			if (Number.isNaN(invitationId)) {
				sendJson(ctx.response, 400, { error: "Invalid invitation ID" });
				return;
			}
			await ctx.deps.githubService.acceptInvitation(invitationId);
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
