import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../response-helpers.js";
import {
	AdminRouteRegistry,
	mapResultToStatus,
	type AdminRouterDeps,
} from "../admin-router-shared.js";

const registry = new AdminRouteRegistry()
	.route({
		method: "GET",
		pattern: /^\/api\/status\/working$/u,
		handler: async (ctx) => {
			const result = await ctx.deps.getAdminStatus.execute();
			if (!result.success) {
				sendJson(ctx.response, mapResultToStatus(result.code), { error: result.message });
				return;
			}
			const workingSessions = result.data.sessions.filter(
				(session) => session.status === "working",
			);
			return {
				status: 200,
				body: {
					working: workingSessions.length > 0,
					count: workingSessions.length,
					sessions: workingSessions.map((session) => ({
						owner: session.owner,
						repo: session.repo,
						issueNumber: session.issueNumber,
						status: session.status,
						lastActivity: session.lastActivity,
					})),
				},
			};
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/maintenance$/u,
		handler: async (ctx) => {
			return { status: 200, body: { draining: ctx.deps.taskController.isDraining() } };
		},
	})
	.route<{
		enabled?: boolean;
	}>({
		method: "POST",
		pattern: /^\/api\/maintenance$/u,
		parseBody: true,
		handler: async (ctx) => {
			const body = ctx.body as { enabled?: boolean };
			const enabled = body.enabled === true;
			ctx.deps.taskController.setDraining(enabled);
			process.stdout.write(
				`[webhook] maintenance mode ${enabled ? "enabled" : "disabled"}\n`,
			);
			return { status: 200, body: { draining: enabled } };
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/status$/u,
		handler: async (ctx) => {
			const result = await ctx.deps.getAdminStatus.execute();
			if (!result.success) {
				sendJson(ctx.response, mapResultToStatus(result.code), { error: result.message });
				return;
			}
			return { status: 200, body: result.data };
		},
	});

export async function handleStatusRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	pathname: string,
): Promise<boolean> {
	return registry.handle(request, response, deps, pathname);
}
