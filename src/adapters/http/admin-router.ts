import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminRouterDeps } from "./admin-router-shared.js";
import { handleOllamaRoutes } from "./admin-routes/ollama-routes.js";
import { handleOnboardingRoutes } from "./admin-routes/onboarding-routes.js";
import { handleRefinementRoutes } from "./admin-routes/refinement-routes.js";
import { handleRepoRoutes } from "./admin-routes/repo-routes.js";
import { handleSessionRoutes } from "./admin-routes/session-routes.js";
import { handleSettingsRoutes } from "./admin-routes/settings-routes.js";
import { handleSkillRoutes } from "./admin-routes/skill-routes.js";
import { handleStatusRoutes } from "./admin-routes/status-routes.js";
import { handleMetricsRoutes } from "./admin-routes/metrics-routes.js";
import { handleAuthRoutes } from "./admin-routes/auth-routes.js";
import { handleUserRoutes } from "./admin-routes/user-routes.js";

export type { AdminRouterDeps } from "./admin-router-shared.js";

export async function handleAdminRoute(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
): Promise<boolean> {
	const requestUrl = new URL(request.url ?? "/", "http://localhost");
	const pathname = requestUrl.pathname;

	return (
		(await handleAuthRoutes(request, response, deps, pathname)) ||
		(await handleUserRoutes(request, response, deps, pathname)) ||
		(await handleOnboardingRoutes(request, response, deps, pathname)) ||
		(await handleStatusRoutes(request, response, deps, pathname)) ||
		(await handleMetricsRoutes(request, response, deps, requestUrl, pathname)) ||
		(await handleSessionRoutes(request, response, deps, requestUrl, pathname)) ||
		(await handleRefinementRoutes(request, response, deps, requestUrl, pathname)) ||
		(await handleRepoRoutes(request, response, deps, pathname)) ||
		(await handleSettingsRoutes(request, response, deps, pathname)) ||
		(await handleOllamaRoutes(request, response, deps, pathname)) ||
		(await handleSkillRoutes(request, response, deps, pathname))
	);
}
