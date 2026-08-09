import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../response-helpers.js";
import {
	AdminRouteRegistry,
	getRequiredDeps,
	type AdminRouterDeps,
} from "../admin-router-shared.js";

const registry = new AdminRouteRegistry()
	.route({
		method: "GET",
		pattern: /^\/api\/openai-codex\/status$/u,
		requiresDeps: ["openaiCodexAuthService"],
		handler: async (ctx) => {
			const { openaiCodexAuthService } = getRequiredDeps(ctx.deps, ["openaiCodexAuthService"]);
			return { status: 200, body: openaiCodexAuthService.getSignInStatus() };
		},
	})
	.route({
		method: "POST",
		pattern: /^\/api\/openai-codex\/login$/u,
		requiresDeps: ["openaiCodexAuthService"],
		handler: async (ctx) => {
			const { openaiCodexAuthService } = getRequiredDeps(ctx.deps, ["openaiCodexAuthService"]);
			const result = await openaiCodexAuthService.beginLogin();
			return { status: 200, body: { authUrl: result.authUrl } };
		},
	})
	.route({
		method: "POST",
		pattern: /^\/api\/openai-codex\/logout$/u,
		requiresDeps: ["openaiCodexAuthService"],
		handler: async (ctx) => {
			const { openaiCodexAuthService } = getRequiredDeps(ctx.deps, ["openaiCodexAuthService"]);
			openaiCodexAuthService.logout();
			return { status: 200, body: { success: true } };
		},
	});

/**
 * Authed ChatGPT Codex OAuth endpoints used by the Settings → AI / LLM screen.
 * The onboarding wizard uses the unauthenticated `/api/onboarding/openai-codex-*`
 * variants so it can run before any admin session exists.
 */
export async function handleOpenAICodexRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	pathname: string,
): Promise<boolean> {
	return registry.handle(request, response, deps, pathname);
}

// Re-exported for tests that assert error responses directly.
export { sendJson };