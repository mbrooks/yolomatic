import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../response-helpers.js";
import {
	AdminRouteRegistry,
	mapResultToStatus,
	type AdminRouterDeps,
} from "../admin-router-shared.js";

/**
 * Admin dashboard metrics. Exposes the persisted per-execution metrics
 * (runtime + token usage) aggregated into daily time-series buckets for the
 * dashboard graphs, plus the most recent executions for the recent-activity
 * list. Token usage is reported per-bucket with an `available` flag so the UI
 * can render "unknown" without breaking aggregates when a provider omits usage.
 */
const registry = new AdminRouteRegistry()
	.route({
		method: "GET",
		pattern: /^\/api\/metrics$/u,
		requiresDeps: ["getMetrics"],
		allowBasicAuth: true,
		handler: async (ctx) => {
			const daysParam = ctx.requestUrl?.searchParams.get("days") ?? undefined;
			const days = daysParam === undefined ? undefined : Number.parseInt(daysParam, 10);
			const result = await ctx.deps.getMetrics!.execute({ days: Number.isFinite(days) ? days : undefined });
			if (!result.success) {
				sendJson(ctx.response, mapResultToStatus(result.code), { error: result.message });
				return;
			}
			return { status: 200, body: result.data };
		},
	});

export async function handleMetricsRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	requestUrl: URL | undefined,
	pathname: string,
): Promise<boolean> {
	if (!pathname.startsWith("/api/metrics")) {
		return false;
	}
	const handled = await registry.handle(request, response, deps, pathname, requestUrl);
	if (!handled) {
		sendJson(response, 404, { error: "Not found" });
		return true;
	}
	return handled;
}