import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionCommand } from "../../../app/commands/run-session-command.js";
import { sendJson } from "../response-helpers.js";
import { AdminRouteRegistry, ValidationError, mapResultToStatus, type AdminRouterDeps } from "../admin-router-shared.js";

const registry = new AdminRouteRegistry()
	.route({
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/([^/]+)\/(-?\d+)\/(implementation|refinement)\/log$/u,
		handler: async (ctx) => {
			const [owner, repo, issueNumberStr, kind] = ctx.params;
			const issueNumber = Number.parseInt(issueNumberStr, 10);
			if (Number.isNaN(issueNumber)) {
				throw new ValidationError("Invalid issue number");
			}
			const since = ctx.requestUrl?.searchParams.get("since") ?? undefined;
			const result = await ctx.deps.getSessionLog.execute(owner, repo, issueNumber, kind as "implementation" | "refinement", since);
			if (!result.success) {
				sendJson(ctx.response, mapResultToStatus(result.code), { error: result.message });
				return;
			}
			return { status: 200, body: result.data };
		},
	})
	.route<{
		command?: SessionCommand;
		payload?: Record<string, unknown>;
	}>({
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/([^/]+)\/(-?\d+)\/(implementation|refinement)\/commands$/u,
		parseBody: true,
		handler: async (ctx) => {
			const [owner, repo, issueNumberStr, kind] = ctx.params;
			const issueNumber = Number.parseInt(issueNumberStr, 10);
			if (Number.isNaN(issueNumber)) {
				throw new ValidationError("Invalid issue number");
			}
			const body = ctx.body as {
				command?: SessionCommand;
				payload?: Record<string, unknown>;
			};
			if (!body.command) {
				throw new ValidationError("Missing command");
			}
			if (kind !== "implementation") {
				throw new ValidationError("Commands are only available for implementation sessions");
			}
			const result = await ctx.deps.runSessionCommand.execute(
				owner,
				repo,
				issueNumber,
				body.command,
				body.payload,
			);
			if (!result.success) {
				sendJson(ctx.response, mapResultToStatus(result.code), { error: result.message });
				return;
			}
			return { status: 200, body: result.data };
		},
	});

export async function handleSessionRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	requestUrl: URL,
	pathname: string,
): Promise<boolean> {
	if (!pathname.startsWith("/api/sessions/")) {
		return false;
	}
	const handled = await registry.handle(request, response, deps, pathname, requestUrl);
	if (!handled) {
		sendJson(response, 404, { error: "Not found" });
		return true;
	}
	return handled;
}
