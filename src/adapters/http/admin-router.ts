import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminRouterDeps } from "./admin-router-shared.js";
import { handleIssueRoutes } from "./admin-routes/issue-routes.js";
import { handleOnboardingRoutes } from "./admin-routes/onboarding-routes.js";
import { handleRepoRoutes } from "./admin-routes/repo-routes.js";
import { handleSessionRoutes } from "./admin-routes/session-routes.js";
import { handleSettingsRoutes } from "./admin-routes/settings-routes.js";
import { handleSkillRoutes } from "./admin-routes/skill-routes.js";
import { handleStatusRoutes } from "./admin-routes/status-routes.js";
import {
	executeIssueChatRequest,
	type IssueChatProgressEvent,
	type IssueChatRequestBody,
} from "../../app/commands/issue-chat-request.js";

export { executeIssueChatRequest };
export type { AdminRouterDeps, IssueChatProgressEvent, IssueChatRequestBody };

export async function handleAdminRoute(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
): Promise<boolean> {
	const requestUrl = new URL(request.url ?? "/", "http://localhost");
	const pathname = requestUrl.pathname;

	return (
		(await handleOnboardingRoutes(request, response, deps, pathname)) ||
		(await handleStatusRoutes(request, response, deps, pathname)) ||
		(await handleSessionRoutes(request, response, deps, requestUrl, pathname)) ||
		(await handleRepoRoutes(request, response, deps, pathname)) ||
		(await handleIssueRoutes(request, response, deps, pathname)) ||
		(await handleSettingsRoutes(request, response, deps, pathname)) ||
		(await handleSkillRoutes(request, response, deps, pathname))
	);
}
