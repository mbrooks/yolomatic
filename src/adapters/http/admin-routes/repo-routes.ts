import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../response-helpers.js";
import {
	AdminRouteRegistry,
	ValidationError,
	type AdminRouterDeps,
} from "../admin-router-shared.js";
import { mapResultToStatus } from "../admin-router-shared.js";

interface ConfiguredRepository {
	owner: string;
	repo: string;
}

function parseConfiguredRepositories(raw: string | undefined): ConfiguredRepository[] {
	if (!raw?.trim()) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) {
			return [];
		}
		const repos: ConfiguredRepository[] = [];
		const seen = new Set<string>();
		for (const item of parsed) {
			if (!item || typeof item !== "object") {
				continue;
			}
			const owner = "owner" in item && typeof item.owner === "string" ? item.owner.trim() : "";
			const repo = "repo" in item && typeof item.repo === "string" ? item.repo.trim() : "";
			if (!owner || !repo) {
				continue;
			}
			const key = `${owner}/${repo}`.toLowerCase();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			repos.push({ owner, repo });
		}
		return repos;
	} catch {
		return [];
	}
}

const registry = new AdminRouteRegistry()
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
			for (const repo of discovered) {
				const key = `${repo.owner}/${repo.repo}`.toLowerCase();
				if (!seen.has(key)) {
					seen.add(key);
					current.push({ owner: repo.owner, repo: repo.repo });
					added++;
				}
			}
			ctx.deps.settingsStore.set("configured_repositories", JSON.stringify(current));
			return { status: 200, body: { repos: discovered, added } };
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
