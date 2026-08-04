import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../response-helpers.js";
import {
	AdminRouteRegistry,
	getRequiredDeps,
	type AdminRouterDeps,
} from "../admin-router-shared.js";

function toUserView(user: { id: string; fullName: string; username: string; createdAt: string; updatedAt: string }) {
	return {
		id: user.id,
		fullName: user.fullName,
		username: user.username,
		createdAt: user.createdAt,
		updatedAt: user.updatedAt,
	};
}

const registry = new AdminRouteRegistry()
	.route<{ username?: string; password?: string }>({
		method: "POST",
		pattern: /^\/api\/login$/u,
		auth: false,
		parseBody: true,
		required: ["username", "password"],
		requiresDeps: ["sessionAuth"],
		handler: async (ctx) => {
			const { sessionAuth } = getRequiredDeps(ctx.deps, ["sessionAuth"]);
			const body = ctx.body as { username: string; password: string };
			const user = sessionAuth.login(ctx.request, ctx.response, body.username.trim(), body.password);
			if (!user) {
				sendJson(ctx.response, 401, { error: "Invalid username or password" });
				return;
			}
			return { status: 200, body: { user: toUserView(user) } };
		},
	})
	.route({
		method: "POST",
		pattern: /^\/api\/logout$/u,
		auth: false,
		handler: async (ctx) => {
			if (!ctx.deps.sessionAuth) {
				return { status: 200, body: { ok: true } };
			}
			ctx.deps.sessionAuth.clearSessionCookie(ctx.response);
			return { status: 200, body: { ok: true } };
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/me$/u,
		requiresDeps: ["sessionAuth"],
		handler: async (ctx) => {
			const { sessionAuth } = getRequiredDeps(ctx.deps, ["sessionAuth"]);
			const user = sessionAuth.verifyRequest(ctx.request);
			if (!user) {
				sendJson(ctx.response, 401, { error: "Unauthorized" });
				return;
			}
			return { status: 200, body: { user: toUserView(user) } };
		},
	});

export async function handleAuthRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	pathname: string,
): Promise<boolean> {
	return registry.handle(request, response, deps, pathname);
}