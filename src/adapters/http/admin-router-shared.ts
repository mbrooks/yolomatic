import type { IncomingMessage, ServerResponse } from "node:http";
import type { GetAdminStatus } from "../../app/queries/get-admin-status.js";
import type { GetSession } from "../../app/queries/get-session.js";
import type { GetSessionLog } from "../../app/queries/get-session-log.js";
import type { GetRefinementLog } from "../../app/queries/get-refinement-log.js";
import type { ListRefinementAttempts } from "../../app/queries/list-refinement-attempts.js";
import type { RunSessionCommand } from "../../app/commands/run-session-command.js";
import type { StartIssueSession } from "../../app/commands/start-issue-session.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { SettingsStore } from "../../settings/store.js";
import type { SkillStore } from "../../skills/store.js";
import type { RepoSkillService } from "../../skills/repo-skill-service.js";
import type { RepositoryStore } from "../../repos/repository-store.js";
import type { RefinementStore } from "../../refinement/store.js";
import { DEFAULT_ADMIN_DEFAULT_PAGE, DEFAULT_ADMIN_PATH } from "../../config.js";
import { sendJson } from "./response-helpers.js";
import type { AdminSessionAuth } from "./admin-auth.js";
import type { UserStore } from "../../users/store.js";
import { readBody } from "../../webhook/http-utils.js";

export class ValidationError extends Error {}
export class NotFoundError extends Error {}

export interface AdminRouteContext {
	request: IncomingMessage;
	response: ServerResponse;
	deps: AdminRouterDeps;
	requestUrl?: URL;
	body: unknown;
	params: string[];
}

export interface AdminRouteDefinition<TBody extends object = Record<string, unknown>> {
	method: string;
	pattern: RegExp;
	/** Authorize the request before invoking the handler. `false` is a public route. */
	auth?: boolean;
	/** When true and `auth` is not `false`, also accept HTTP Basic Auth (RFC 7617) verified against the `users` table. */
	allowBasicAuth?: boolean;
	parseBody?: boolean;
	required?: string[];
	requiresDeps?: RequiredAdminRouteDep[];
	parseErrorStatus?: number;
	handler: (ctx: AdminRouteContext) => Promise<void | { status: number; body: unknown }>;
}

const missingDependencyErrors = {
	githubService: "GitHub service not configured",
	settingsStore: "Settings store not configured",
	skillStore: "Skill store not configured",
	repoSkillService: "Repo skill service not configured",
	startIssueSession: "Session executor not configured",
	repositoryStore: "Repository store not configured",
	refinementStore: "Refinement store not configured",
	ollamaSignInService: "Ollama sign-in service not configured",
	sessionAuth: "Admin authentication not configured",
	userStore: "User store not configured",
} satisfies Partial<Record<keyof AdminRouterDeps, string>>;

export type RequiredAdminRouteDep = keyof typeof missingDependencyErrors;
export type RouteDepsFor<T extends RequiredAdminRouteDep> = {
	[K in T]-?: NonNullable<AdminRouterDeps[K]>;
};

export class AdminRouteRegistry {
	private readonly routes: AdminRouteDefinition<any>[] = [];

	route<TBody extends object>(definition: AdminRouteDefinition<TBody>): this {
		this.routes.push(definition);
		return this;
	}

	async handle(
		request: IncomingMessage,
		response: ServerResponse,
		deps: AdminRouterDeps,
		pathname: string,
		requestUrl?: URL,
	): Promise<boolean> {
		for (const definition of this.routes) {
			if (request.method !== definition.method) {
				continue;
			}
			const match = definition.pattern.exec(pathname);
			if (!match) {
				continue;
			}

			if (definition.auth !== false) {
				if (!checkAdminJson(request, response, deps, definition.allowBasicAuth === true)) {
					return true;
				}
			}

			let body: unknown = {};
			if (definition.parseBody) {
				try {
					const raw = await readBody(request);
					body = raw.length === 0 ? {} : JSON.parse(raw.toString("utf8"));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(`[admin] ${pathname} body parse error: ${message}\n`);
					sendJson(response, definition.parseErrorStatus ?? 400, { error: message });
					return true;
				}
			}

			if (definition.required && definition.required.length > 0) {
				const missing = definition.required.filter((field) => {
					const value = (body as Record<string, unknown>)[field];
					return value === undefined || value === null || value === "";
				});
				if (missing.length > 0) {
					const suffix = missing.join(", ");
					const message = `Missing required field${missing.length === 1 ? "" : "s"}: ${suffix}`;
					sendJson(response, 400, { error: message });
					return true;
				}
			}

			if (
				definition.requiresDeps &&
				!requireDeps(
					{
						request,
						response,
						deps,
						requestUrl,
						body,
						params: match.slice(1) as string[],
					},
					definition.requiresDeps,
				)
			) {
				return true;
			}

			try {
				const result = await definition.handler({
					request,
					response,
					deps,
					requestUrl,
					body,
					params: match.slice(1) as string[],
				});
				if (result) {
					sendJson(response, result.status, result.body);
				}
			} catch (error) {
				if (error instanceof ValidationError) {
					sendJson(response, 400, { error: error.message });
				} else if (error instanceof NotFoundError) {
					sendJson(response, 404, { error: error.message });
				} else {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(`[admin] ${pathname} error: ${message}\n`);
					sendJson(response, 500, { error: message });
				}
			}
			return true;
		}
		return false;
	}
}

export interface AdminRouterDeps {
	getAdminStatus: GetAdminStatus;
	getSession: GetSession;
	getSessionLog: GetSessionLog;
	runSessionCommand: RunSessionCommand;
	startIssueSession?: StartIssueSession;
	taskController: TaskControlService;
	githubService?: import("../../ports/github-service.js").GitHubService;
	sessionAuth?: AdminSessionAuth;
	userStore?: UserStore;
	adminAssetsDir: string;
	settingsStore?: SettingsStore;
	skillStore?: SkillStore;
	repoSkillService?: RepoSkillService;
	repositoryStore?: RepositoryStore;
	refinementStore?: RefinementStore;
	getRefinementLog?: GetRefinementLog;
	listRefinementAttempts?: ListRefinementAttempts;
	onOnboardingComplete?: () => void | Promise<void>;
	adminPath?: string;
	adminDefaultPage?: string;
	ollamaSignInService?: import("../../ollama/signin-status.js").OllamaSignInService;
}

export function resolveAdminPath(deps: AdminRouterDeps): string {
	return deps.adminPath ?? DEFAULT_ADMIN_PATH;
}

export function resolveAdminDefaultPage(deps: AdminRouterDeps): string {
	return deps.adminDefaultPage ?? DEFAULT_ADMIN_DEFAULT_PAGE;
}

export function mapResultToStatus(code: string): number {
	switch (code) {
		case "not_found":
			return 404;
		case "invalid_state":
			return 400;
		case "unauthorized":
			return 401;
		case "conflict":
			return 409;
		default:
			return 500;
	}
}

export function requireDeps(
	ctx: AdminRouteContext,
	requiredDeps: RequiredAdminRouteDep[],
): boolean {
	for (const dep of requiredDeps) {
		if (ctx.deps[dep]) {
			continue;
		}
		sendJson(ctx.response, 500, { error: missingDependencyErrors[dep] });
		return false;
	}
	return true;
}

export function getRequiredDeps<T extends RequiredAdminRouteDep>(
	deps: AdminRouterDeps,
	_requiredDeps: readonly T[],
): RouteDepsFor<T> {
	return deps as unknown as RouteDepsFor<T>;
}

export function checkAdminJson(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	allowBasicAuth = false,
): boolean {
	if (!deps.sessionAuth) {
		sendJson(response, 503, { error: "Server is in onboarding mode. Complete setup first." });
		return false;
	}
	if (allowBasicAuth) {
		return deps.sessionAuth.requireAdminJsonAllowBasic(request, response);
	}
	return deps.sessionAuth.requireAdminJson(request, response);
}

export function checkAdminTextAllowOnboarding(
	_request: IncomingMessage,
	_response: ServerResponse,
	_deps: AdminRouterDeps,
): boolean {
	// The admin HTML shell and its static assets are always served so the SPA
	// can render the login screen; protected data is gated by the JSON API
	// routes via checkAdminJson.
	return true;
}
