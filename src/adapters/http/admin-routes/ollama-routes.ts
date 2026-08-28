import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../response-helpers.js";
import {
	AdminRouteRegistry,
	getRequiredDeps,
	type AdminRouterDeps,
} from "../admin-router-shared.js";
import { DEFAULT_OLLAMA_CONTAINER_NAME } from "../../../ollama/signin-status.js";
import { pullOllamaModel } from "../../../ollama/pull-model.js";

const registry = new AdminRouteRegistry()
	.route({
		method: "GET",
		pattern: /^\/api\/ollama\/signin$/u,
		requiresDeps: ["settingsStore", "ollamaSignInService"],
		handler: async (ctx) => {
			const { settingsStore, ollamaSignInService } = getRequiredDeps(ctx.deps, [
				"settingsStore",
				"ollamaSignInService",
			]);
			const containerName = settingsStore.getString(
				"ollama_container_name",
				DEFAULT_OLLAMA_CONTAINER_NAME,
			);
			const result = await ollamaSignInService.checkSignInStatus({ containerName });
			return { status: 200, body: result };
		},
	})
	.route<{ model?: string; name?: string }>({
		method: "POST",
		pattern: /^\/api\/ollama\/pull$/u,
		parseBody: true,
		handler: async (ctx) => {
			const body = (ctx.body ?? {}) as { model?: string; name?: string };
			const model = body.model?.trim() || body.name?.trim() || "";
			if (!model) {
				sendJson(ctx.response, 400, { error: "Missing required field: model" });
				return;
			}
			return { status: 200, body: await pullOllamaModel(model) };
		},
	});

/**
 * Re-check Ollama sign-in status. Returns true if the request was handled
 * (matched a registered admin route), false otherwise.
 */
export async function handleOllamaRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	pathname: string,
): Promise<boolean> {
	return registry.handle(request, response, deps, pathname);
}

// Re-exported for tests that assert error responses directly.
export { sendJson };