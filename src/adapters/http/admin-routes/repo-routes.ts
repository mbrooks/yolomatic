import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../response-helpers.js";
import {
	AdminRouteRegistry,
	ValidationError,
	getRequiredDeps,
	type AdminRouterDeps,
} from "../admin-router-shared.js";
import { mapResultToStatus } from "../admin-router-shared.js";
import {
	type RepoGitHubEventMode,
	type Repository,
} from "../../../repos/repository.js";
import { NotFoundError } from "../admin-router-shared.js";

interface RepoSettingView {
	key: "github_event_mode" | "default_branch";
	value: string;
	default: string;
	override: string | null;
	inherited: boolean;
	requiresRestart: boolean;
	description: string;
	options?: string[];
}

function normalizeGlobalEventMode(raw: string): RepoGitHubEventMode {
	const mode = raw.trim().toLowerCase();
	return mode === "polling" || mode === "both" ? mode : "webhook";
}

function buildRepoSettingViews(
	deps: AdminRouterDeps,
	owner: string,
	repo: string,
	configured: Repository | null,
): RepoSettingView[] {
	const globalEventMode = normalizeGlobalEventMode(deps.settingsStore!.getString("github_event_mode", "webhook"));
	const globalDefaultBranch = deps.settingsStore!.getString("default_branch", "main");
	return [
		{
			key: "github_event_mode",
			value: configured?.githubEventMode ?? globalEventMode,
			default: globalEventMode,
			override: configured?.githubEventMode ?? null,
			inherited: !configured?.githubEventMode,
			requiresRestart: true,
			description: "Choose whether this repository is driven by GitHub webhooks, polling, or both.",
			options: ["webhook", "polling", "both"],
		},
		{
			key: "default_branch",
			value: configured?.defaultBranch ?? globalDefaultBranch,
			default: globalDefaultBranch,
			override: configured?.defaultBranch ?? null,
			inherited: !configured?.defaultBranch,
			requiresRestart: false,
			description: "Override the base branch used for new worktrees, empty repo initialization, and pull requests.",
		},
	];
}

const registry = new AdminRouteRegistry()
	.route<{
		owner?: string;
		repo?: string;
	}>({
		method: "POST",
		pattern: /^\/api\/repos$/u,
		parseBody: true,
		required: ["owner", "repo"],
		requiresDeps: ["githubService", "repositoryStore"],
		handler: async (ctx) => {
			const { githubService, repositoryStore } = getRequiredDeps(ctx.deps, [
				"githubService",
				"repositoryStore",
			]);
			const body = ctx.body as { owner?: unknown; repo?: unknown };
			const owner = String(body.owner).trim();
			const repo = String(body.repo).trim();
			if (!owner || !repo) {
				throw new ValidationError("owner and repo are required");
			}
			const info = await githubService.getRepository(owner, repo);
			if (!info) {
				throw new NotFoundError("Repository not found or not accessible");
			}
			const existing = await repositoryStore.get(info.owner, info.repo);
			if (existing) {
				return {
					status: 200,
					body: {
						owner: info.owner,
						repo: info.repo,
						fullName: info.fullName,
						added: false,
						message: "Repository already configured",
					},
				};
			}
			await repositoryStore.upsert({
				owner: info.owner,
				repo: info.repo,
				fullName: info.fullName,
				visibility: info.visibility,
			});
			return {
				status: 200,
				body: {
					owner: info.owner,
					repo: info.repo,
					fullName: info.fullName,
					added: true,
				},
			};
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/repos\/accessible$/u,
		requiresDeps: ["githubService", "repositoryStore"],
		handler: async (ctx) => {
			const { githubService, repositoryStore } = getRequiredDeps(ctx.deps, [
				"githubService",
				"repositoryStore",
			]);
			const user = await githubService.getAuthenticatedUser();
			if (!user) {
				sendJson(ctx.response, 500, { error: "GitHub token is invalid or not configured" });
				return;
			}
			const repositories = await githubService.listAccessibleRepositories();
			const configured = (await repositoryStore.list()).map((repo) => ({ owner: repo.owner, repo: repo.repo }));
			return { status: 200, body: { repositories, configured } };
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/settings$/u,
		requiresDeps: ["settingsStore", "repositoryStore"],
		handler: async (ctx) => {
			const { repositoryStore } = getRequiredDeps(ctx.deps, ["repositoryStore"]);
			const [owner, repo] = ctx.params;
			const configured = await repositoryStore.get(owner, repo);
			return {
				status: 200,
				body: { settings: buildRepoSettingViews(ctx.deps, owner, repo, configured) },
			};
		},
	})
	.route<{
		github_event_mode?: string;
		default_branch?: string;
	}>({
		method: "PATCH",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/settings$/u,
		parseBody: true,
		requiresDeps: ["repositoryStore"],
		handler: async (ctx) => {
			const { repositoryStore } = getRequiredDeps(ctx.deps, ["repositoryStore"]);
			const [owner, repo] = ctx.params;
			const body = ctx.body as { github_event_mode?: string; default_branch?: string };
			const existing = await repositoryStore.get(owner, repo);
			let nextGithubEventMode = existing?.githubEventMode ?? null;
			let nextDefaultBranch = existing?.defaultBranch ?? null;
			const requiresRestart: string[] = [];

			if ("github_event_mode" in body) {
				const mode = body.github_event_mode?.trim().toLowerCase();
				if (mode === "webhook" || mode === "polling" || mode === "both") {
					nextGithubEventMode = mode as RepoGitHubEventMode;
					requiresRestart.push("github_event_mode");
				} else if (!mode) {
					nextGithubEventMode = null;
				} else {
					throw new ValidationError("github_event_mode must be webhook, polling, or both");
				}
			}

			if ("default_branch" in body) {
				const branch = body.default_branch?.trim();
				nextDefaultBranch = branch || null;
			}

			if (existing) {
				await repositoryStore.upsert({
					owner: existing.owner,
					repo: existing.repo,
					fullName: existing.fullName,
					visibility: existing.visibility,
					githubEventMode: nextGithubEventMode,
					defaultBranch: nextDefaultBranch,
				});
			} else {
				await repositoryStore.upsert({
					owner,
					repo,
					githubEventMode: nextGithubEventMode,
					defaultBranch: nextDefaultBranch,
				});
			}
			return { status: 200, body: { updated: ["github_event_mode", "default_branch"], requiresRestart } };
		},
	})
	.route({
		method: "DELETE",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)$/u,
		requiresDeps: ["repositoryStore"],
		handler: async (ctx) => {
			const { repositoryStore } = getRequiredDeps(ctx.deps, ["repositoryStore"]);
			const [owner, repo] = ctx.params;
			const removed = await repositoryStore.remove(owner, repo);
			return { status: 200, body: { removed } };
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/context$/u,
		requiresDeps: ["githubService"],
		handler: async (ctx) => {
			const { githubService } = getRequiredDeps(ctx.deps, ["githubService"]);
			const [owner, repo] = ctx.params;
			const [labels, templates, recentCommits, relatedIssues] = await Promise.all([
				githubService.listLabels(owner, repo),
				githubService.getIssueTemplates(owner, repo),
				githubService.listRecentCommits(owner, repo, 5),
				githubService.listRelatedIssues(owner, repo, "bug OR feature OR enhancement", 5),
			]);
			return { status: 200, body: { labels, templates, recentCommits, relatedIssues } };
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/issues$/u,
		requiresDeps: ["githubService"],
		handler: async (ctx) => {
			const { githubService } = getRequiredDeps(ctx.deps, ["githubService"]);
			const [owner, repo] = ctx.params;
			const issues = await githubService.listOpenIssues(owner, repo);
			return { status: 200, body: { issues } };
		},
	})
	.route<{
		title?: string;
		body?: string;
		labels?: string[];
	}>({
		method: "POST",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/issues\/(-?\d+)\/assign$/u,
		parseBody: true,
		requiresDeps: ["githubService", "settingsStore", "startIssueSession"],
		handler: async (ctx) => {
			const { githubService, settingsStore, startIssueSession } = getRequiredDeps(
				ctx.deps,
				["githubService", "settingsStore", "startIssueSession"],
			);
			const [owner, repo, issueNumberStr] = ctx.params;
			const issueNumber = Number.parseInt(issueNumberStr, 10);
			const yolomaticUsername = settingsStore.get("github_username");
			if (!yolomaticUsername) {
				sendJson(ctx.response, 500, { error: "Yolomatic GitHub username not configured" });
				return;
			}
			const body = ctx.body as {
				title?: string;
				body?: string;
				labels?: string[];
			};
			if (!body.title) {
				throw new ValidationError("Missing required field: title");
			}
			await githubService.updateIssueAssignees(owner, repo, issueNumber, [yolomaticUsername]);
			startIssueSession.execute(
				owner,
				repo,
				issueNumber,
				body.title,
				body.body ?? "",
				body.labels ?? [],
			).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				process.stdout.write(`[webhook] background session error: ${message}\n`);
			});
			return {
				status: 202,
				body: { started: true, status: "queued", message: "Session started in background" },
			};
		},
	})
	.route<{
		title?: string;
		body?: string;
		labels?: string[];
	}>({
		method: "POST",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/issues\/(-?\d+)\/start-session$/u,
		parseBody: true,
		requiresDeps: ["githubService", "settingsStore", "startIssueSession"],
		handler: async (ctx) => {
			const { settingsStore, startIssueSession } = getRequiredDeps(ctx.deps, [
				"githubService",
				"settingsStore",
				"startIssueSession",
			]);
			const [owner, repo, issueNumberStr] = ctx.params;
			const issueNumber = Number.parseInt(issueNumberStr, 10);
			const yolomaticUsername = settingsStore.get("github_username");
			if (!yolomaticUsername) {
				sendJson(ctx.response, 500, { error: "Yolomatic GitHub username not configured" });
				return;
			}
			const body = ctx.body as {
				title?: string;
				body?: string;
				labels?: string[];
			};
			if (!body.title) {
				throw new ValidationError("Missing required field: title");
			}
			const result = await startIssueSession.execute(
				owner,
				repo,
				issueNumber,
				body.title,
				body.body ?? "",
				body.labels ?? [],
			);
			if (!result.success) {
				sendJson(ctx.response, mapResultToStatus(result.code), { error: result.message });
				return;
			}
			return { status: 200, body: result.data };
		},
	})
	.route({
		method: "POST",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/issues\/(-?\d+)\/close$/u,
		requiresDeps: ["githubService"],
		handler: async (ctx) => {
			const { githubService } = getRequiredDeps(ctx.deps, ["githubService"]);
			const [owner, repo, issueNumberStr] = ctx.params;
			const issueNumber = Number.parseInt(issueNumberStr, 10);
			await githubService.closeIssue(owner, repo, issueNumber);
			return { status: 200, body: { closed: true } };
		},
	})
	.route({
		method: "POST",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/issues\/(-?\d+)\/mark-do-not-work$/u,
		requiresDeps: ["githubService"],
		handler: async (ctx) => {
			const { githubService } = getRequiredDeps(ctx.deps, ["githubService"]);
			const [owner, repo, issueNumberStr] = ctx.params;
			const issueNumber = Number.parseInt(issueNumberStr, 10);
			await githubService.addLabels(owner, repo, issueNumber, ["wontfix"]);
			await githubService.closeIssue(owner, repo, issueNumber);
			return { status: 200, body: { closed: true, labeled: true } };
		},
	});

export async function handleRepoRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	pathname: string,
): Promise<boolean> {
	return registry.handle(request, response, deps, pathname);
}
