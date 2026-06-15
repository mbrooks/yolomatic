import type { IncomingMessage, ServerResponse } from "node:http";
import type { GetAdminStatus } from "../../app/queries/get-admin-status.js";
import type { GetSession } from "../../app/queries/get-session.js";
import type { GetSessionLog } from "../../app/queries/get-session-log.js";
import type { RunSessionCommand } from "../../app/commands/run-session-command.js";
import type { StartIssueSession } from "../../app/commands/start-issue-session.js";
import type { CronStore } from "../../cron/store.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { SettingsStore } from "../../settings/store.js";
import type { SkillStore } from "../../skills/store.js";
import type { RepoSkillService } from "../../skills/repo-skill-service.js";
import { sendJson } from "./response-helpers.js";
import { requireAdminJson, requireAdminText } from "./admin-auth.js";
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
	auth?: boolean;
	parseBody?: boolean;
	required?: string[];
	parseErrorStatus?: number;
	handler: (ctx: AdminRouteContext) => Promise<void | { status: number; body: unknown }>;
}

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
				if (!checkAdminJson(request, response, deps)) {
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
	cronStore?: CronStore;
	getAdminStatus: GetAdminStatus;
	getSession: GetSession;
	getSessionLog: GetSessionLog;
	runSessionCommand: RunSessionCommand;
	startIssueSession?: StartIssueSession;
	taskController: TaskControlService;
	githubService?: import("../../ports/github-service.js").GitHubService;
	adminUsername?: string;
	adminPassword?: string;
	adminAssetsDir: string;
	settingsStore?: SettingsStore;
	skillStore?: SkillStore;
	repoSkillService?: RepoSkillService;
	onOnboardingComplete?: () => void | Promise<void>;
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

export function getCredentials(deps: AdminRouterDeps): { username?: string; password?: string } {
	if (deps.adminUsername && deps.adminPassword) {
		return { username: deps.adminUsername, password: deps.adminPassword };
	}
	const u = deps.settingsStore?.get("admin_username") ?? undefined;
	const p = deps.settingsStore?.get("admin_password") ?? undefined;
	if (u && p) {
		return { username: u, password: p };
	}
	return {};
}

export function checkAdminJson(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
): boolean {
	const { username, password } = getCredentials(deps);
	if (!username || !password) {
		sendJson(response, 503, { error: "Server is in onboarding mode. Complete setup first." });
		return false;
	}
	return requireAdminJson(request, response, username, password);
}

export function checkAdminTextAllowOnboarding(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
): boolean {
	const { username, password } = getCredentials(deps);
	if (!username || !password) {
		return true;
	}
	return requireAdminText(request, response, username, password);
}

export function mergeRepoAndServerSkills(
	repoSkills: import("../../skills/model.js").RepoSkill[],
	serverSkills: import("../../skills/model.js").ServerSkill[],
): import("../../skills/model.js").RepoSkill[] {
	const repoMap = new Map(repoSkills.map((skill) => [skill.name, skill]));
	const merged: import("../../skills/model.js").RepoSkill[] = [];

	for (const serverSkill of serverSkills) {
		if (repoMap.has(serverSkill.name)) {
			const repoSkill = repoMap.get(serverSkill.name)!;
			merged.push({ ...repoSkill, source: "repo" });
			continue;
		}
		merged.push({
			name: serverSkill.name,
			description: serverSkill.description,
			content: serverSkill.content,
			updatedAt: serverSkill.updatedAt,
			source: "inherited",
		});
	}

	for (const repoSkill of repoSkills) {
		if (!serverSkills.some((skill) => skill.name === repoSkill.name)) {
			merged.push({ ...repoSkill, source: "repo" });
		}
	}

	return merged.sort((a, b) => a.name.localeCompare(b.name));
}
