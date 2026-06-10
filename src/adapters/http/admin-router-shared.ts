import type { IncomingMessage, ServerResponse } from "node:http";
import type { GetAdminStatus } from "../../app/queries/get-admin-status.js";
import type { GetSession } from "../../app/queries/get-session.js";
import type { GetSessionLog } from "../../app/queries/get-session-log.js";
import type { RunSessionCommand } from "../../app/commands/run-session-command.js";
import type { CronStore } from "../../cron/store.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { SettingsStore } from "../../settings/store.js";
import type { SkillStore } from "../../skills/store.js";
import type { RepoSkillService } from "../../skills/repo-skill-service.js";
import { sendJson } from "./response-helpers.js";
import { requireAdminJson, requireAdminText } from "./admin-auth.js";

export interface AdminRouterDeps {
	cronStore?: CronStore;
	getAdminStatus: GetAdminStatus;
	getSession: GetSession;
	getSessionLog: GetSessionLog;
	runSessionCommand: RunSessionCommand;
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
			enabled: serverSkill.enabled,
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
