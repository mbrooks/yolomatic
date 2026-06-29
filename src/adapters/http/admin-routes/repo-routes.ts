import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../response-helpers.js";
import {
	AdminRouteRegistry,
	ValidationError,
	type AdminRouterDeps,
} from "../admin-router-shared.js";
import { mapResultToStatus } from "../admin-router-shared.js";
import {
	findConfiguredRepository,
	parseConfiguredRepositories,
	removeConfiguredRepository,
	stringifyConfiguredRepositories,
	upsertConfiguredRepository,
	type RepoGitHubEventMode,
} from "../../../repos/configured-repositories.js";
import { NotFoundError } from "../admin-router-shared.js";
import { isPublicVisibility } from "../../../ports/github-service.js";

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
): RepoSettingView[] {
	const globalEventMode = normalizeGlobalEventMode(deps.settingsStore!.getString("github_event_mode", "webhook"));
	const globalDefaultBranch = deps.settingsStore!.getString("default_branch", "main");
	const configured = findConfiguredRepository(
		parseConfiguredRepositories(deps.settingsStore!.get("configured_repositories")),
		owner,
		repo,
	);
	return [
		{
			key: "github_event_mode",
			value: configured?.settings?.github_event_mode ?? globalEventMode,
			default: globalEventMode,
			override: configured?.settings?.github_event_mode ?? null,
			inherited: !configured?.settings?.github_event_mode,
			requiresRestart: true,
			description: "Choose whether this repository is driven by GitHub webhooks, polling, or both.",
			options: ["webhook", "polling", "both"],
		},
		{
			key: "default_branch",
			value: configured?.settings?.default_branch ?? globalDefaultBranch,
			default: globalDefaultBranch,
			override: configured?.settings?.default_branch ?? null,
			inherited: !configured?.settings?.default_branch,
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
		handler: async (ctx) => {
			if (!ctx.deps.githubService) {
				sendJson(ctx.response, 500, { error: "GitHub service not configured" });
				return;
			}
			if (!ctx.deps.settingsStore) {
				sendJson(ctx.response, 500, { error: "Settings store not configured" });
				return;
			}
			const body = ctx.body as { owner?: unknown; repo?: unknown };
			const owner = String(body.owner).trim();
			const repo = String(body.repo).trim();
			if (!owner || !repo) {
				throw new ValidationError("owner and repo are required");
			}
			const info = await ctx.deps.githubService.getRepository(owner, repo);
			if (!info) {
				throw new NotFoundError("Repository not found or not accessible");
			}
			const currentRaw = ctx.deps.settingsStore.get("configured_repositories") ?? "[]";
			const current = parseConfiguredRepositories(currentRaw);
			const key = `${info.owner}/${info.repo}`.toLowerCase();
			if (current.some((r) => `${r.owner}/${r.repo}`.toLowerCase() === key)) {
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
			current.push({ owner: info.owner, repo: info.repo });
			ctx.deps.settingsStore.set("configured_repositories", stringifyConfiguredRepositories(current));
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
		method: "POST",
		pattern: /^\/api\/repos\/scan$/u,
		handler: async (ctx) => {
			if (!ctx.deps.githubService) {
				sendJson(ctx.response, 500, { error: "GitHub service not configured" });
				return;
			}
			if (!ctx.deps.settingsStore) {
				sendJson(ctx.response, 500, { error: "Settings store not configured" });
				return;
			}
			const user = await ctx.deps.githubService.getAuthenticatedUser();
			if (!user) {
				sendJson(ctx.response, 500, { error: "GitHub token is invalid or not configured" });
				return;
			}
			const discovered = await ctx.deps.githubService.listAccessibleRepositories();
			const currentRaw = ctx.deps.settingsStore.get("configured_repositories") ?? "[]";
			const current = parseConfiguredRepositories(currentRaw);
			const seen = new Set(current.map((r) => `${r.owner}/${r.repo}`.toLowerCase()));
			let added = 0;
			const skipped: import("../../../ports/github-service.js").AccessibleRepo[] = [];
			for (const repo of discovered) {
				const key = `${repo.owner}/${repo.repo}`.toLowerCase();
				if (seen.has(key)) {
					continue;
				}
				if (isPublicVisibility(repo.visibility)) {
					skipped.push(repo);
					continue;
				}
				seen.add(key);
				current.push({ owner: repo.owner, repo: repo.repo });
				added++;
			}
			ctx.deps.settingsStore.set("configured_repositories", stringifyConfiguredRepositories(current));
			return { status: 200, body: { repos: discovered, added, skipped } };
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/settings$/u,
		handler: async (ctx) => {
			if (!ctx.deps.settingsStore) {
				sendJson(ctx.response, 500, { error: "Settings store not configured" });
				return;
			}
			const [owner, repo] = ctx.params;
			return { status: 200, body: { settings: buildRepoSettingViews(ctx.deps, owner, repo) } };
		},
	})
	.route<{
		github_event_mode?: string;
		default_branch?: string;
	}>({
		method: "PATCH",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/settings$/u,
		parseBody: true,
		handler: async (ctx) => {
			if (!ctx.deps.settingsStore) {
				sendJson(ctx.response, 500, { error: "Settings store not configured" });
				return;
			}
			const [owner, repo] = ctx.params;
			const body = ctx.body as { github_event_mode?: string; default_branch?: string };
			const configuredRepositories = parseConfiguredRepositories(ctx.deps.settingsStore.get("configured_repositories"));
			const existing = findConfiguredRepository(configuredRepositories, owner, repo) ?? { owner, repo };
			const settings = { ...(existing.settings ?? {}) };
			const requiresRestart: string[] = [];

			if ("github_event_mode" in body) {
				const mode = body.github_event_mode?.trim().toLowerCase();
				if (mode === "webhook" || mode === "polling" || mode === "both") {
					settings.github_event_mode = mode;
					requiresRestart.push("github_event_mode");
				} else if (!mode) {
					delete settings.github_event_mode;
				} else {
					throw new ValidationError("github_event_mode must be webhook, polling, or both");
				}
			}

			if ("default_branch" in body) {
				const branch = body.default_branch?.trim();
				if (branch) {
					settings.default_branch = branch;
				} else {
					delete settings.default_branch;
				}
			}

			const nextRepositories = upsertConfiguredRepository(
				configuredRepositories,
				Object.keys(settings).length > 0 ? { owner, repo, settings } : { owner, repo },
			);
			ctx.deps.settingsStore.set("configured_repositories", stringifyConfiguredRepositories(nextRepositories));
			return { status: 200, body: { updated: ["github_event_mode", "default_branch"], requiresRestart } };
		},
	})
	.route({
		method: "DELETE",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)$/u,
		handler: async (ctx) => {
			if (!ctx.deps.settingsStore) {
				sendJson(ctx.response, 500, { error: "Settings store not configured" });
				return;
			}
			const [owner, repo] = ctx.params;
			const current = parseConfiguredRepositories(ctx.deps.settingsStore.get("configured_repositories"));
			const next = removeConfiguredRepository(current, owner, repo);
			const removed = next.length < current.length;
			ctx.deps.settingsStore.set("configured_repositories", stringifyConfiguredRepositories(next));
			return { status: 200, body: { removed } };
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/context$/u,
		handler: async (ctx) => {
			if (!ctx.deps.githubService) {
				sendJson(ctx.response, 500, { error: "GitHub service not configured" });
				return;
			}
			const [owner, repo] = ctx.params;
			const [labels, templates, recentCommits, relatedIssues] = await Promise.all([
				ctx.deps.githubService.listLabels(owner, repo),
				ctx.deps.githubService.getIssueTemplates(owner, repo),
				ctx.deps.githubService.listRecentCommits(owner, repo, 5),
				ctx.deps.githubService.listRelatedIssues(owner, repo, "bug OR feature OR enhancement", 5),
			]);
			return { status: 200, body: { labels, templates, recentCommits, relatedIssues } };
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/issues$/u,
		handler: async (ctx) => {
			if (!ctx.deps.githubService) {
				sendJson(ctx.response, 500, { error: "GitHub service not configured" });
				return;
			}
			const [owner, repo] = ctx.params;
			const issues = await ctx.deps.githubService.listOpenIssues(owner, repo);
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
		handler: async (ctx) => {
			if (!ctx.deps.githubService) {
				sendJson(ctx.response, 500, { error: "GitHub service not configured" });
				return;
			}
			if (!ctx.deps.settingsStore) {
				sendJson(ctx.response, 500, { error: "Settings store not configured" });
				return;
			}
			if (!ctx.deps.startIssueSession) {
				sendJson(ctx.response, 500, { error: "Session executor not configured" });
				return;
			}
			const [owner, repo, issueNumberStr] = ctx.params;
			const issueNumber = Number.parseInt(issueNumberStr, 10);
			const tarsUsername = ctx.deps.settingsStore.get("github_username");
			if (!tarsUsername) {
				sendJson(ctx.response, 500, { error: "TARS GitHub username not configured" });
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
			await ctx.deps.githubService.updateIssueAssignees(owner, repo, issueNumber, [tarsUsername]);
			ctx.deps.startIssueSession.execute(
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
		handler: async (ctx) => {
			if (!ctx.deps.githubService) {
				sendJson(ctx.response, 500, { error: "GitHub service not configured" });
				return;
			}
			if (!ctx.deps.settingsStore) {
				sendJson(ctx.response, 500, { error: "Settings store not configured" });
				return;
			}
			if (!ctx.deps.startIssueSession) {
				sendJson(ctx.response, 500, { error: "Session executor not configured" });
				return;
			}
			const [owner, repo, issueNumberStr] = ctx.params;
			const issueNumber = Number.parseInt(issueNumberStr, 10);
			const tarsUsername = ctx.deps.settingsStore.get("github_username");
			if (!tarsUsername) {
				sendJson(ctx.response, 500, { error: "TARS GitHub username not configured" });
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
			const result = await ctx.deps.startIssueSession.execute(
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
		handler: async (ctx) => {
			if (!ctx.deps.githubService) {
				sendJson(ctx.response, 500, { error: "GitHub service not configured" });
				return;
			}
			const [owner, repo, issueNumberStr] = ctx.params;
			const issueNumber = Number.parseInt(issueNumberStr, 10);
			await ctx.deps.githubService.closeIssue(owner, repo, issueNumber);
			return { status: 200, body: { closed: true } };
		},
	})
	.route({
		method: "POST",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/issues\/(-?\d+)\/mark-do-not-work$/u,
		handler: async (ctx) => {
			if (!ctx.deps.githubService) {
				sendJson(ctx.response, 500, { error: "GitHub service not configured" });
				return;
			}
			const [owner, repo, issueNumberStr] = ctx.params;
			const issueNumber = Number.parseInt(issueNumberStr, 10);
			await ctx.deps.githubService.addLabels(owner, repo, issueNumber, ["wontfix"]);
			await ctx.deps.githubService.closeIssue(owner, repo, issueNumber);
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
