import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../response-helpers.js";
import { AdminRouteRegistry, mapResultToStatus, type AdminRouterDeps } from "../admin-router-shared.js";

const registry = new AdminRouteRegistry()
	.route({
		method: "GET",
		pattern: /^\/api\/refinements\/([^/]+)\/([^/]+)\/(-?\d+)\/refinement\/log$/u,
		requiresDeps: ["refinementStore"],
		handler: async (ctx) => {
			const [owner, repo, issueNumberStr] = ctx.params;
			const issueNumber = Number.parseInt(issueNumberStr, 10);
			const since = ctx.requestUrl?.searchParams.get("since") ?? undefined;
			const result = await ctx.deps.getRefinementLog!.execute(owner, repo, issueNumber, since);
			if (!result.success) {
				sendJson(ctx.response, mapResultToStatus(result.code), { error: result.message });
				return;
			}
			return { status: 200, body: result.data };
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/refinements\/([^/]+)\/([^/]+)\/(-?\d+)\/refinement\/attempts$/u,
		requiresDeps: ["refinementStore"],
		handler: async (ctx) => {
			const [owner, repo, issueNumberStr] = ctx.params;
			const issueNumber = Number.parseInt(issueNumberStr, 10);
			const result = await ctx.deps.listRefinementAttempts!.execute(owner, repo, issueNumber);
			if (!result.success) {
				sendJson(ctx.response, mapResultToStatus(result.code), { error: result.message });
				return;
			}
			return { status: 200, body: result.data };
		},
	});

export async function handleRefinementRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	requestUrl: URL,
	pathname: string,
): Promise<boolean> {
	if (!pathname.startsWith("/api/refinements/")) {
		return false;
	}
	const handled = await registry.handle(request, response, deps, pathname, requestUrl);
	if (!handled) {
		sendJson(response, 404, { error: "Not found" });
		return true;
	}
	return handled;
}
