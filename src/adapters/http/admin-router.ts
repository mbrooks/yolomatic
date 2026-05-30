import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../../webhook/http-utils.js";
import { sendHtml, sendJson, sendText } from "./response-helpers.js";
import { requireAdminJson, requireAdminText } from "./admin-auth.js";
import type { GetAdminStatus } from "../../app/queries/get-admin-status.js";
import type { GetSession } from "../../app/queries/get-session.js";
import type { GetSessionLog } from "../../app/queries/get-session-log.js";
import type { RunSessionCommand, SessionCommand } from "../../app/commands/run-session-command.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { CronStore } from "../../cron/store.js";
import { computeNextRunAt } from "../../cron/store.js";
import { generateIssueViaLLM } from "../../app/commands/generate-issue.js";
import { chatIssueViaLLM } from "../../app/commands/issue-chat.js";
import { adminHtml, serveAdminAsset } from "./asset-server.js";
import type { SettingsStore } from "../../settings/store.js";
import type { SkillStore } from "../../skills/store.js";
import type { RepoSkillService } from "../../skills/repo-skill-service.js";
import { getSettingDefinition } from "../../settings/model.js";
import type { IssueChatResponse } from "../../admin/api/issues.js";

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
}

export interface IssueChatRequestBody {
	owner?: string;
	repo?: string;
	privacyMode?: boolean;
	selectedTemplate?: string;
	context?: import("../../app/commands/issue-prompts.js").RepoContext;
	draft?: {
		title?: string;
		body?: string;
		labels?: string[];
		assignees?: string[];
	};
	messages?: Array<{ role?: "assistant" | "user"; text?: string }>;
}

export interface IssueChatProgressEvent {
	type: "started" | "creating" | "completed" | "error";
	message: string;
	response?: IssueChatResponse;
}

function mapResultToStatus(code: string): number {
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

function getCredentials(deps: AdminRouterDeps): { username?: string; password?: string } {
	if (deps.adminUsername && deps.adminPassword) {
		return { username: deps.adminUsername, password: deps.adminPassword };
	}
	const u = deps.settingsStore?.get("admin_username") ?? undefined;
	const p = deps.settingsStore?.get("admin_password") ?? undefined;
	if (u && p) return { username: u, password: p };
	return {};
}

function checkAdminJson(request: IncomingMessage, response: ServerResponse, deps: AdminRouterDeps): boolean {
	const { username, password } = getCredentials(deps);
	if (!username || !password) {
		sendJson(response, 503, { error: "Server is in onboarding mode. Complete setup first." });
		return false;
	}
	return requireAdminJson(request, response, username, password);
}

function checkAdminTextAllowOnboarding(request: IncomingMessage, response: ServerResponse, deps: AdminRouterDeps): boolean {
	const { username, password } = getCredentials(deps);
	if (!username || !password) {
		return true; // allow without auth during onboarding
	}
	return requireAdminText(request, response, username, password);
}

export async function executeIssueChatRequest(
	deps: AdminRouterDeps,
	body: IssueChatRequestBody,
	onProgress?: (event: IssueChatProgressEvent) => void,
): Promise<IssueChatResponse> {
	if (!Array.isArray(body.messages) || body.messages.length === 0) {
		throw new Error("Missing required field: messages");
	}

	onProgress?.({
		type: "started",
		message: "Thinking through the issue draft...",
	});

	const chatResult = await chatIssueViaLLM({
		owner: body.owner,
		repo: body.repo,
		draft: body.draft,
		context: body.context,
		options: { privacyMode: body.privacyMode ?? false, selectedTemplate: body.selectedTemplate },
		messages: body.messages
			.filter((message): message is { role: "assistant" | "user"; text: string } =>
				(message.role === "assistant" || message.role === "user") && typeof message.text === "string",
			),
	});

	if (chatResult.shouldCreate) {
		if (!deps.githubService) {
			throw new Error("GitHub service not configured");
		}
		if (!chatResult.owner || !chatResult.repo || !chatResult.draft.title) {
			const response = {
				...chatResult,
				readyToCreate: false,
				shouldCreate: false,
				message: "I still need the repository and a clear title before I can create the issue.",
			};
			onProgress?.({
				type: "completed",
				message: response.message,
				response,
			});
			return response;
		}

		onProgress?.({
			type: "creating",
			message: `Creating issue in ${chatResult.owner}/${chatResult.repo}...`,
		});

		const createdIssue = await deps.githubService.createIssue(
			chatResult.owner,
			chatResult.repo,
			chatResult.draft.title,
			chatResult.draft.body,
			chatResult.draft.labels,
			chatResult.draft.assignees,
		);
		const response = {
			...chatResult,
			createdIssue: {
				number: createdIssue.number,
				html_url: createdIssue.html_url,
			},
		};
		onProgress?.({
			type: "completed",
			message: response.message,
			response,
		});
		return response;
	}

	onProgress?.({
		type: "completed",
		message: chatResult.message,
		response: chatResult,
	});
	return chatResult;
}

export async function handleAdminRoute(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
): Promise<boolean> {
	const requestUrl = new URL(request.url ?? "/", "http://localhost");
	const pathname = requestUrl.pathname;

	if (request.method === "GET" && pathname === "/api/onboarding/status") {
		if (!deps.settingsStore) {
			sendJson(response, 500, { error: "Settings store not configured" });
			return true;
		}
		const required = ["github_token", "github_username", "webhook_secret", "admin_username", "admin_password"];
		const missing = required.filter((k) => {
			const val = deps.settingsStore!.get(k);
			return val === undefined || val === "";
		});
		sendJson(response, 200, { complete: missing.length === 0, missing });
		return true;
	}

	if (request.method === "POST" && pathname === "/api/onboarding") {
		if (!deps.settingsStore) {
			sendJson(response, 500, { error: "Settings store not configured" });
			return true;
		}
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as Record<string, string>;
			const required = ["github_token", "github_username", "webhook_secret", "admin_username", "admin_password"];
			const missing = required.filter((k) => !body[k]?.trim());
			if (missing.length > 0) {
				sendJson(response, 400, { error: `Missing required fields: ${missing.join(", ")}` });
				return true;
			}
			for (const key of required) {
				deps.settingsStore.set(key, body[key].trim());
			}
			sendJson(response, 200, { success: true, requiresRestart: required });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 400, { error: message });
		}
		return true;
	}

	if (request.method === "GET" && (pathname === "/tarsadmin" || pathname === "/tarsadmin/")) {
		if (!checkAdminTextAllowOnboarding(request, response, deps)) {
			return true;
		}
		sendHtml(response, 200, await adminHtml(deps.adminAssetsDir));
		return true;
	}

	if (request.method === "GET" && pathname.startsWith("/tarsadmin/")) {
		if (!checkAdminTextAllowOnboarding(request, response, deps)) {
			return true;
		}
		await serveAdminAsset(response, deps.adminAssetsDir, pathname.slice("/tarsadmin/".length));
		return true;
	}

	if (request.method === "GET" && pathname === "/api/status/working") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		try {
			const result = await deps.getAdminStatus.execute();
			if (!result.success) {
				sendJson(response, mapResultToStatus(result.code), { error: result.message });
				return true;
			}
			const workingSessions = result.data.sessions.filter((s) => s.status === "working");
			sendJson(response, 200, {
				working: workingSessions.length > 0,
				count: workingSessions.length,
				sessions: workingSessions.map((s) => ({
					owner: s.owner,
					repo: s.repo,
					issueNumber: s.issueNumber,
					status: s.status,
					lastActivity: s.lastActivity,
				})),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[webhook] status/working error: ${message}\n`);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	if (request.method === "GET" && pathname === "/api/maintenance") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		sendJson(response, 200, { draining: deps.taskController.isDraining() });
		return true;
	}

	if (request.method === "POST" && pathname === "/api/maintenance") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as { enabled?: boolean };
			const enabled = body.enabled === true;
			deps.taskController.setDraining(enabled);
			process.stdout.write(`[webhook] maintenance mode ${enabled ? "enabled" : "disabled"}\n`);
			sendJson(response, 200, { draining: enabled });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[webhook] maintenance error: ${message}\n`);
			sendJson(response, 400, { error: message });
		}
		return true;
	}

	if (request.method === "GET" && pathname === "/api/status") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		try {
			const result = await deps.getAdminStatus.execute();
			if (!result.success) {
				sendJson(response, mapResultToStatus(result.code), { error: result.message });
				return true;
			}
			sendJson(response, 200, result.data);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[webhook] status error: ${message}\n`);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	if (request.method === "GET" && pathname.startsWith("/api/sessions/")) {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}

		const logMatch = /^\/api\/sessions\/([^/]+)\/([^/]+)\/(-?\d+)\/log$/u.exec(pathname);
		if (logMatch) {
			const [, owner, repo, issueNumberStr] = logMatch;
			const issueNumber = Number.parseInt(issueNumberStr, 10);
			if (Number.isNaN(issueNumber)) {
				sendJson(response, 400, { error: "Invalid issue number" });
				return true;
			}
			const since = requestUrl.searchParams.get("since") ?? undefined;
			try {
				const result = await deps.getSessionLog.execute(owner, repo, issueNumber, since ?? undefined);
				if (!result.success) {
					sendJson(response, mapResultToStatus(result.code), { error: result.message });
					return true;
				}
				sendJson(response, 200, result.data);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				process.stdout.write(`[webhook] log error: ${message}\n`);
				sendJson(response, 500, { error: message });
			}
			return true;
		}

		sendJson(response, 404, { error: "Not found" });
		return true;
	}

	if (request.method === "POST" && pathname.startsWith("/api/sessions/")) {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}

		const commandMatch = /^\/api\/sessions\/([^/]+)\/([^/]+)\/(-?\d+)\/commands$/u.exec(pathname);
		if (commandMatch) {
			const [, owner, repo, issueNumberStr] = commandMatch;
			const issueNumber = Number.parseInt(issueNumberStr, 10);
			if (Number.isNaN(issueNumber)) {
				sendJson(response, 400, { error: "Invalid issue number" });
				return true;
			}
			try {
				const body = JSON.parse((await readBody(request)).toString("utf8")) as { command?: SessionCommand; payload?: Record<string, unknown> };
				if (!body.command) {
					sendJson(response, 400, { error: "Missing command" });
					return true;
				}
				const result = await deps.runSessionCommand.execute(owner, repo, issueNumber, body.command, body.payload);
				if (!result.success) {
					sendJson(response, mapResultToStatus(result.code), { error: result.message });
					return true;
				}
				sendJson(response, 200, result.data);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				process.stdout.write(`[webhook] command error: ${message}\n`);
				sendJson(response, 500, { error: message });
			}
			return true;
		}

		sendJson(response, 404, { error: "Not found" });
		return true;
	}

	// Cron routes
	if (pathname.startsWith("/api/crons/")) {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.cronStore) {
			sendJson(response, 500, { error: "Cron store not configured" });
			return true;
		}

		// GET /api/crons/:owner/:repo
		const listMatch = /^\/api\/crons\/([^/]+)\/([^/]+)$/u.exec(pathname);
		if (listMatch && request.method === "GET") {
			const [, owner, repo] = listMatch;
			try {
				const jobs = await deps.cronStore.listForRepo(owner, repo);
				sendJson(response, 200, { crons: jobs });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: message });
			}
			return true;
		}

		// POST /api/crons/:owner/:repo
		if (listMatch && request.method === "POST") {
			const [, owner, repo] = listMatch;
			try {
				const body = JSON.parse((await readBody(request)).toString("utf8")) as {
					name?: string;
					description?: string;
					prompt?: string;
					scheduleType?: string;
					scheduleValue?: string;
					branch?: string;
					notificationChannel?: string;
				};
				if (!body.name || !body.prompt || !body.scheduleType || !body.scheduleValue) {
					sendJson(response, 400, { error: "Missing required fields: name, prompt, scheduleType, scheduleValue" });
					return true;
				}
				const job = await deps.cronStore.createJob(
					owner,
					repo,
					body.name,
					body.description || "",
					body.prompt,
					body.scheduleType as import("../../cron/store.js").CronScheduleType,
					body.scheduleValue,
					body.branch || "main",
					body.notificationChannel || null,
				);
				sendJson(response, 201, job);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 400, { error: message });
			}
			return true;
		}

		// GET /api/crons/:owner/:repo/:id
		const detailMatch = /^\/api\/crons\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(pathname);
		if (detailMatch && request.method === "GET") {
			const [, owner, repo, id] = detailMatch;
			try {
				const job = await deps.cronStore.get(owner, repo, id);
				if (!job) {
					sendJson(response, 404, { error: "Cron job not found" });
					return true;
				}
				sendJson(response, 200, job);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: message });
			}
			return true;
		}

		// PATCH /api/crons/:owner/:repo/:id
		if (detailMatch && request.method === "PATCH") {
			const [, owner, repo, id] = detailMatch;
			try {
				const existing = await deps.cronStore.get(owner, repo, id);
				if (!existing) {
					sendJson(response, 404, { error: "Cron job not found" });
					return true;
				}
				const body = JSON.parse((await readBody(request)).toString("utf8")) as Partial<{
					name: string;
					description: string;
					prompt: string;
					scheduleType: string;
					scheduleValue: string;
					branch: string;
					notificationChannel: string;
					enabled: boolean;
				}>;
				let shouldRecompute = false;
				if (body.name !== undefined) existing.name = body.name;
				if (body.description !== undefined) existing.description = body.description;
				if (body.prompt !== undefined) existing.prompt = body.prompt;
				if (body.branch !== undefined) existing.branch = body.branch;
				if (body.notificationChannel !== undefined) existing.notificationChannel = body.notificationChannel;
				if (body.scheduleType !== undefined) {
					existing.scheduleType = body.scheduleType as import("../../cron/store.js").CronScheduleType;
					shouldRecompute = true;
				}
				if (body.scheduleValue !== undefined) {
					existing.scheduleValue = body.scheduleValue;
					shouldRecompute = true;
				}
				if (body.enabled !== undefined) {
					if (body.enabled && !existing.enabled) {
						shouldRecompute = true;
					}
					existing.enabled = body.enabled;
				}
				if (shouldRecompute) {
					existing.nextRunAt = computeNextRunAt(existing.scheduleType, existing.scheduleValue);
				}
				await deps.cronStore.set(existing);
				sendJson(response, 200, existing);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 400, { error: message });
			}
			return true;
		}

		// DELETE /api/crons/:owner/:repo/:id
		if (detailMatch && request.method === "DELETE") {
			const [, owner, repo, id] = detailMatch;
			try {
				await deps.cronStore.delete(owner, repo, id);
				sendJson(response, 200, { deleted: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: message });
			}
			return true;
		}

		// GET /api/crons/:owner/:repo/:id/runs
		const runsMatch = /^\/api\/crons\/([^/]+)\/([^/]+)\/([^/]+)\/runs$/u.exec(pathname);
		if (runsMatch && request.method === "GET") {
			const [, owner, repo, id] = runsMatch;
			try {
				const runs = await deps.cronStore.getRuns(owner, repo, id);
				sendJson(response, 200, { runs });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: message });
			}
			return true;
		}

		// POST /api/crons/:owner/:repo/:id/run
		const runMatch = /^\/api\/crons\/([^/]+)\/([^/]+)\/([^/]+)\/run$/u.exec(pathname);
		if (runMatch && request.method === "POST") {
			const [, owner, repo, id] = runMatch;
			try {
				const job = await deps.cronStore.get(owner, repo, id);
				if (!job) {
					sendJson(response, 404, { error: "Cron job not found" });
					return true;
				}
				job.nextRunAt = new Date().toISOString();
				await deps.cronStore.set(job);
				sendJson(response, 200, { queued: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: message });
			}
			return true;
		}
	}

	// GET /api/repos/:owner/:repo/context
	const repoContextMatch = /^\/api\/repos\/([^/]+)\/([^/]+)\/context$/u.exec(pathname);
	if (repoContextMatch && request.method === "GET") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.githubService) {
			sendJson(response, 500, { error: "GitHub service not configured" });
			return true;
		}
		const [, owner, repo] = repoContextMatch;
		try {
			const [labels, templates, recentCommits, relatedIssues] = await Promise.all([
				deps.githubService.listLabels(owner, repo),
				deps.githubService.getIssueTemplates(owner, repo),
				deps.githubService.listRecentCommits(owner, repo, 5),
				deps.githubService.listRelatedIssues(owner, repo, "bug OR feature OR enhancement", 5),
			]);
			sendJson(response, 200, {
				labels,
				templates,
				recentCommits,
				relatedIssues,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	// GET /api/repos/:owner/:repo/issues
	const repoIssuesMatch = /^\/api\/repos\/([^/]+)\/([^/]+)\/issues$/u.exec(pathname);
	if (repoIssuesMatch && request.method === "GET") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.githubService) {
			sendJson(response, 500, { error: "GitHub service not configured" });
			return true;
		}
		const [, owner, repo] = repoIssuesMatch;
		try {
			const issues = await deps.githubService.listOpenIssues(owner, repo);
			sendJson(response, 200, { issues });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	// POST /api/issues/generate
	if (request.method === "POST" && pathname === "/api/issues/generate") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as {
				owner?: string;
				repo?: string;
				prompt?: string;
				privacyMode?: boolean;
				selectedTemplate?: string;
				context?: import("../../app/commands/issue-prompts.js").RepoContext;
			};
			if (!body.owner || !body.repo || !body.prompt) {
				sendJson(response, 400, { error: "Missing required fields: owner, repo, prompt" });
				return true;
			}
			const generated = await generateIssueViaLLM(
				body.owner,
				body.repo,
				body.prompt,
				body.context,
				{ privacyMode: body.privacyMode ?? false, selectedTemplate: body.selectedTemplate },
			);
			sendJson(response, 200, generated);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	// POST /api/issues/chat
	if (request.method === "POST" && pathname === "/api/issues/chat") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as IssueChatRequestBody;
			if (!Array.isArray(body.messages) || body.messages.length === 0) {
				sendJson(response, 400, { error: "Missing required field: messages" });
				return true;
			}
			sendJson(response, 200, await executeIssueChatRequest(deps, body));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, message === "Missing required field: messages" ? 400 : 500, { error: message });
		}
		return true;
	}

	// POST /api/issues
	if (request.method === "POST" && pathname === "/api/issues") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.githubService) {
			sendJson(response, 500, { error: "GitHub service not configured" });
			return true;
		}
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as {
				owner?: string;
				repo?: string;
				title?: string;
				body?: string;
				labels?: string[];
				assignees?: string[];
			};
			if (!body.owner || !body.repo || !body.title) {
				sendJson(response, 400, { error: "Missing required fields: owner, repo, title" });
				return true;
			}
			const issue = await deps.githubService.createIssue(
		body.owner,
				body.repo,
				body.title,
				body.body || "",
				body.labels,
				body.assignees,
			);
			sendJson(response, 201, issue);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	// Settings routes
	if (pathname === "/api/settings") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.settingsStore) {
			sendJson(response, 500, { error: "Settings store not configured" });
			return true;
		}

		if (request.method === "GET") {
			try {
				const settings = deps.settingsStore.getAllViews();
				sendJson(response, 200, { settings });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: message });
			}
			return true;
		}

		if (request.method === "PATCH") {
			try {
				const body = JSON.parse((await readBody(request)).toString("utf8")) as Record<string, string | number | boolean>;
				const requiresRestart: string[] = [];
				const updated: string[] = [];
				for (const [key, value] of Object.entries(body)) {
					const def = getSettingDefinition(key);
					if (def?.sensitive && value === "") {
						continue;
					}
					deps.settingsStore.setTyped(key, value);
					if (def?.requiresRestart) {
						requiresRestart.push(key);
					}
					updated.push(key);
				}
				sendJson(response, 200, { updated, requiresRestart });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 400, { error: message });
			}
			return true;
		}
	}

	// Server-level Skills routes
	if (pathname === "/api/skills") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.skillStore) {
			sendJson(response, 500, { error: "Skill store not configured" });
			return true;
		}

		if (request.method === "GET") {
			try {
				const skills = await deps.skillStore.listAll();
				sendJson(response, 200, { skills });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: message });
			}
			return true;
		}

		if (request.method === "POST") {
			try {
				const body = JSON.parse((await readBody(request)).toString("utf8")) as {
					name?: string;
					description?: string;
					content?: string;
					enabled?: boolean;
				};
				if (!body.name || !body.content) {
					sendJson(response, 400, { error: "Missing required fields: name, content" });
					return true;
				}
				const skill = await deps.skillStore.create({
					name: body.name,
					description: body.description || "",
					content: body.content,
					enabled: body.enabled ?? true,
				});
				sendJson(response, 201, skill);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 400, { error: message });
			}
			return true;
		}
	}

	const serverSkillDetailMatch = /^\/api\/skills\/([^/]+)$/u.exec(pathname);
	if (serverSkillDetailMatch && request.method === "GET") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.skillStore) {
			sendJson(response, 500, { error: "Skill store not configured" });
			return true;
		}
		const [, id] = serverSkillDetailMatch;
		try {
			const skill = await deps.skillStore.get(id);
			if (!skill) {
				sendJson(response, 404, { error: "Skill not found" });
				return true;
			}
			sendJson(response, 200, skill);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	if (serverSkillDetailMatch && request.method === "PATCH") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.skillStore) {
			sendJson(response, 500, { error: "Skill store not configured" });
			return true;
		}
		const [, id] = serverSkillDetailMatch;
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as Partial<{
				name: string;
				description: string;
				content: string;
				enabled: boolean;
			}>;
			const updated = await deps.skillStore.update(id, body);
			if (!updated) {
				sendJson(response, 404, { error: "Skill not found" });
				return true;
			}
			sendJson(response, 200, updated);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 400, { error: message });
		}
		return true;
	}

	if (serverSkillDetailMatch && request.method === "DELETE") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.skillStore) {
			sendJson(response, 500, { error: "Skill store not configured" });
			return true;
		}
		const [, id] = serverSkillDetailMatch;
		try {
			await deps.skillStore.delete(id);
			sendJson(response, 200, { deleted: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	// Repo-level Skills routes
	const repoSkillsMatch = /^\/api\/repos\/([^/]+)\/([^/]+)\/skills$/u.exec(pathname);
	if (repoSkillsMatch && request.method === "GET") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.repoSkillService) {
			sendJson(response, 500, { error: "Repo skill service not configured" });
			return true;
		}
		const [, owner, repo] = repoSkillsMatch;
		try {
			const repoSkills = await deps.repoSkillService.listRepoSkills(owner, repo);
			const serverSkills = deps.skillStore ? await deps.skillStore.listAll() : [];
			const merged = mergeRepoAndServerSkills(repoSkills, serverSkills);
			sendJson(response, 200, { skills: merged });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	if (repoSkillsMatch && request.method === "POST") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.repoSkillService) {
			sendJson(response, 500, { error: "Repo skill service not configured" });
			return true;
		}
		const [, owner, repo] = repoSkillsMatch;
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as {
				name?: string;
				description?: string;
				content?: string;
				enabled?: boolean;
			};
			if (!body.name || !body.content) {
				sendJson(response, 400, { error: "Missing required fields: name, content" });
				return true;
			}
			const result = await deps.repoSkillService.saveRepoSkill(owner, repo, {
				name: body.name,
				description: body.description || "",
				content: body.content,
				enabled: body.enabled ?? true,
			});
			if (!result.success) {
				sendJson(response, 500, { error: result.error || "Failed to save skill" });
				return true;
			}
			const updated = await deps.repoSkillService.listRepoSkills(owner, repo);
			const found = updated.find((s) => s.name === body.name);
			sendJson(response, 201, found ?? { name: body.name });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 400, { error: message });
		}
		return true;
	}

	const repoSkillDetailMatch = /^\/api\/repos\/([^/]+)\/([^/]+)\/skills\/([^/]+)$/u.exec(pathname);
	if (repoSkillDetailMatch && request.method === "GET") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.repoSkillService) {
			sendJson(response, 500, { error: "Repo skill service not configured" });
			return true;
		}
		const [, owner, repo, name] = repoSkillDetailMatch;
		try {
			const skill = await deps.repoSkillService.getRepoSkill(owner, repo, name);
			if (!skill) {
				sendJson(response, 404, { error: "Skill not found" });
				return true;
			}
			sendJson(response, 200, skill);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	if (repoSkillDetailMatch && request.method === "PATCH") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.repoSkillService) {
			sendJson(response, 500, { error: "Repo skill service not configured" });
			return true;
		}
		const [, owner, repo, name] = repoSkillDetailMatch;
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as Partial<{
				name: string;
				description: string;
				content: string;
				enabled: boolean;
			}>;
			const existing = await deps.repoSkillService.getRepoSkill(owner, repo, name);
			if (!existing) {
				sendJson(response, 404, { error: "Skill not found" });
				return true;
			}
			if (body.name !== undefined && body.name !== name) {
				// Rename: delete old, create new
				await deps.repoSkillService.deleteRepoSkill(owner, repo, name);
			}
			const result = await deps.repoSkillService.saveRepoSkill(owner, repo, {
				name: body.name ?? name,
				description: body.description ?? existing.description,
				content: body.content ?? existing.content,
				enabled: body.enabled ?? existing.enabled,
			});
			if (!result.success) {
				sendJson(response, 500, { error: result.error || "Failed to save skill" });
				return true;
			}
			sendJson(response, 200, { name: body.name ?? name });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 400, { error: message });
		}
		return true;
	}

	if (repoSkillDetailMatch && request.method === "DELETE") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.repoSkillService) {
			sendJson(response, 500, { error: "Repo skill service not configured" });
			return true;
		}
		const [, owner, repo, name] = repoSkillDetailMatch;
		try {
			const result = await deps.repoSkillService.deleteRepoSkill(owner, repo, name);
			if (!result.success) {
				sendJson(response, 500, { error: result.error || "Failed to delete skill" });
				return true;
			}
			sendJson(response, 200, { deleted: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	return false;
}

function mergeRepoAndServerSkills(
	repoSkills: import("../../skills/model.js").RepoSkill[],
	serverSkills: import("../../skills/model.js").ServerSkill[],
): import("../../skills/model.js").RepoSkill[] {
	const repoMap = new Map(repoSkills.map((s) => [s.name, s]));
	const merged: import("../../skills/model.js").RepoSkill[] = [];
	for (const serverSkill of serverSkills) {
		if (repoMap.has(serverSkill.name)) {
			const repoSkill = repoMap.get(serverSkill.name)!;
			merged.push({ ...repoSkill, source: "repo" });
		} else {
			merged.push({
				name: serverSkill.name,
				description: serverSkill.description,
				content: serverSkill.content,
				enabled: serverSkill.enabled,
				updatedAt: serverSkill.updatedAt,
				source: "inherited",
			});
		}
	}
	for (const repoSkill of repoSkills) {
		if (!serverSkills.some((s) => s.name === repoSkill.name)) {
			merged.push({ ...repoSkill, source: "repo" });
		}
	}
	return merged.sort((a, b) => a.name.localeCompare(b.name));
}
