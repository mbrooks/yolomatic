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
	normalizeRepoBooleanOverride,
	resolveRepoBuildModelOverride,
} from "../../../repos/repository.js";
import { NotFoundError } from "../admin-router-shared.js";
import { getWorkerTemplate, listWorkerTemplates } from "../../../worker/templates.js";

interface RepoSettingView {
	key:
		| "github_event_mode"
		| "default_branch"
		| "worker_template"
		| "issue_new_comment_enabled"
		| "issue_admin_link_in_comments_enabled"
		| "pi_agent_build_model";
	value: string;
	default: string;
	override: string | null;
	inherited: boolean;
	requiresRestart: boolean;
	description: string;
	options?: string[];
	optionLabels?: Record<string, string>;
	/** Global provider the build model resolves against when no slash-form override selects one. */
	providerDefault?: string;
}

function normalizeGlobalEventMode(raw: string): RepoGitHubEventMode {
	const mode = raw.trim().toLowerCase();
	return mode === "polling" || mode === "both" ? mode : "webhook";
}

/** Render a nullable boolean override as the string the admin UI exchanges. */
function booleanOverrideString(value: boolean | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	return value ? "true" : "false";
}

function buildRepoSettingViews(
	deps: AdminRouterDeps,
	owner: string,
	repo: string,
	configured: Repository | null,
): RepoSettingView[] {
	const globalEventMode = normalizeGlobalEventMode(deps.settingsStore!.getString("github_event_mode", "webhook"));
	const globalDefaultBranch = deps.settingsStore!.getString("default_branch", "main");
	const globalWorkerTemplate = deps.settingsStore!.getString("default_worker_template", "node");
	const globalNewComment = deps.settingsStore!.getBoolean("issue_new_comment_enabled", true);
	const globalAdminLink = deps.settingsStore!.getBoolean("issue_admin_link_in_comments_enabled", true);
	// Effective global build model: the build-model setting wins over the
	// plain default model, mirroring the worker launch chain.
	const globalBuildModel =
		deps.settingsStore!.getString("pi_agent_build_model", "").trim()
		|| deps.settingsStore!.getString("pi_agent_model", "").trim();
	// The global provider the repo UI's build-model dropdown resolves inherited
	// and bare-id overrides against. pi_agent_provider's own default is ollama.
	const globalProvider = deps.settingsStore!.getString("pi_agent_provider", "ollama").trim() || "ollama";
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
		{
			key: "worker_template",
			value: configured?.workerTemplate ?? globalWorkerTemplate,
			default: globalWorkerTemplate,
			override: configured?.workerTemplate ?? null,
			inherited: !configured?.workerTemplate,
			requiresRestart: true,
			description: "Choose an installed worker image for this project, or inherit the global default.",
			options: listWorkerTemplates().map((template) => template.id),
			optionLabels: Object.fromEntries(
				listWorkerTemplates().map((template) => [
					template.id,
					`${template.label} (${template.dockerfile})`,
				]),
			),
		},
		{
			key: "issue_new_comment_enabled",
			value: (configured?.issueNewCommentEnabled ?? globalNewComment) ? "true" : "false",
			default: globalNewComment ? "true" : "false",
			override: booleanOverrideString(configured?.issueNewCommentEnabled ?? null),
			inherited: configured?.issueNewCommentEnabled == null,
			requiresRestart: false,
			description: "Post an automatic comment on newly opened issues explaining available Yolomatic commands.",
			options: ["true", "false"],
			optionLabels: { true: "Enabled", false: "Disabled" },
		},
		{
			key: "issue_admin_link_in_comments_enabled",
			value: (configured?.issueAdminLinkInCommentsEnabled ?? globalAdminLink) ? "true" : "false",
			default: globalAdminLink ? "true" : "false",
			override: booleanOverrideString(configured?.issueAdminLinkInCommentsEnabled ?? null),
			inherited: configured?.issueAdminLinkInCommentsEnabled == null,
			requiresRestart: false,
			description: "Include a link to the admin UI in the status comments Yolomatic posts on issues.",
			options: ["true", "false"],
			optionLabels: { true: "Enabled", false: "Disabled" },
		},
		{
			key: "pi_agent_build_model",
			value: resolveRepoBuildModelOverride(configured) ?? globalBuildModel,
			default: globalBuildModel,
			override: resolveRepoBuildModelOverride(configured) ?? null,
			inherited: !resolveRepoBuildModelOverride(configured),
			// Model settings take effect without a restart, matching the global
			// pi_agent_model setting's no-restart contract.
			requiresRestart: false,
			description: "Build model used for this repository's implementation, feedback, and PR-review sessions. Use provider/model form to target a different provider, or leave empty to inherit the global model. Issue refinements always use the global model.",
			providerDefault: globalProvider,
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
		worker_template?: string;
		issue_new_comment_enabled?: string;
		issue_admin_link_in_comments_enabled?: string;
	}>({
		method: "PATCH",
		pattern: /^\/api\/repos\/([^/]+)\/([^/]+)\/settings$/u,
		parseBody: true,
		requiresDeps: ["repositoryStore"],
		handler: async (ctx) => {
			const { repositoryStore } = getRequiredDeps(ctx.deps, ["repositoryStore"]);
			const [owner, repo] = ctx.params;
			const body = ctx.body as {
				github_event_mode?: string;
				default_branch?: string;
				worker_template?: string;
				issue_new_comment_enabled?: string;
				issue_admin_link_in_comments_enabled?: string;
				pi_agent_build_model?: string;
			};
			const existing = await repositoryStore.get(owner, repo);
			let nextGithubEventMode = existing?.githubEventMode ?? null;
			let nextDefaultBranch = existing?.defaultBranch ?? null;
			let nextWorkerTemplate = existing?.workerTemplate ?? null;
			let nextIssueNewCommentEnabled = existing?.issueNewCommentEnabled ?? null;
			let nextIssueAdminLinkInCommentsEnabled = existing?.issueAdminLinkInCommentsEnabled ?? null;
			let nextPiAgentBuildModel = resolveRepoBuildModelOverride(existing) ?? null;
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

			if ("worker_template" in body) {
				const template = body.worker_template?.trim();
				if (!template) {
					nextWorkerTemplate = null;
				} else if (getWorkerTemplate(template)) {
					nextWorkerTemplate = template;
					requiresRestart.push("worker_template");
				} else {
					throw new ValidationError("worker_template must be an installed worker template");
				}
			}

			if ("issue_new_comment_enabled" in body) {
				const normalized = normalizeRepoBooleanOverride(body.issue_new_comment_enabled);
				if (
					body.issue_new_comment_enabled !== undefined &&
					body.issue_new_comment_enabled !== "" &&
					body.issue_new_comment_enabled !== null &&
					normalized === null
				) {
					throw new ValidationError("issue_new_comment_enabled must be true or false");
				}
				nextIssueNewCommentEnabled = normalized;
			}

			if ("issue_admin_link_in_comments_enabled" in body) {
				const normalized = normalizeRepoBooleanOverride(body.issue_admin_link_in_comments_enabled);
				if (
					body.issue_admin_link_in_comments_enabled !== undefined &&
					body.issue_admin_link_in_comments_enabled !== "" &&
					body.issue_admin_link_in_comments_enabled !== null &&
					normalized === null
				) {
					throw new ValidationError("issue_admin_link_in_comments_enabled must be true or false");
				}
				nextIssueAdminLinkInCommentsEnabled = normalized;
			}

			// Free-text build-model override, mirroring the global pi_agent_model
			// setting: no registry validation here. An unresolvable value is
			// handled by the worker's resolve-and-warn-fallback path at launch.
			if ("pi_agent_build_model" in body) {
				nextPiAgentBuildModel = body.pi_agent_build_model?.trim() || null;
			}

			if (existing) {
				await repositoryStore.upsert({
					owner: existing.owner,
					repo: existing.repo,
					fullName: existing.fullName,
					visibility: existing.visibility,
					githubEventMode: nextGithubEventMode,
					defaultBranch: nextDefaultBranch,
					workerTemplate: nextWorkerTemplate,
					issueNewCommentEnabled: nextIssueNewCommentEnabled,
					issueAdminLinkInCommentsEnabled: nextIssueAdminLinkInCommentsEnabled,
					piAgentBuildModel: nextPiAgentBuildModel,
				});
			} else {
				await repositoryStore.upsert({
					owner,
					repo,
					githubEventMode: nextGithubEventMode,
					defaultBranch: nextDefaultBranch,
					workerTemplate: nextWorkerTemplate,
					issueNewCommentEnabled: nextIssueNewCommentEnabled,
					issueAdminLinkInCommentsEnabled: nextIssueAdminLinkInCommentsEnabled,
					piAgentBuildModel: nextPiAgentBuildModel,
				});
			}
			return { status: 200, body: { updated: ["github_event_mode", "default_branch", "worker_template", "issue_new_comment_enabled", "issue_admin_link_in_comments_enabled", "pi_agent_build_model"], requiresRestart } };
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
