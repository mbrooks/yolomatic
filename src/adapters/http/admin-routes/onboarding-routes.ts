import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { adminHtml, serveAdminAsset } from "../asset-server.js";
import { sendHtml, sendJson } from "../response-helpers.js";
import {
	AdminRouteRegistry,
	ValidationError,
	checkAdminTextAllowOnboarding,
	type AdminRouterDeps,
} from "../admin-router-shared.js";
import { GitHubServiceAdapter } from "../../../adapters/github/github-service-adapter.js";
import {
	parseConfiguredRepositories,
	stringifyConfiguredRepositories,
	upsertConfiguredRepository,
} from "../../../repos/configured-repositories.js";
import { WorkspaceManager } from "../../../workspace/manager.js";

const REQUIRED_ONBOARDING_SETTINGS = [
	"github_token",
	"github_username",
	"webhook_secret",
	"admin_username",
	"admin_password",
];

function storeConfiguredRepositories(
	deps: AdminRouterDeps,
	repos: Array<{ owner: string; repo: string }>,
): void {
	let configured = parseConfiguredRepositories(deps.settingsStore!.get("configured_repositories"));
	for (const repo of repos) {
		const owner = repo.owner.trim();
		const name = repo.repo.trim();
		if (!owner || !name) {
			continue;
		}
		configured = upsertConfiguredRepository(configured, { owner, repo: name });
	}
	deps.settingsStore!.set("configured_repositories", stringifyConfiguredRepositories(configured));
}

function getMissingOnboardingSettings(deps: AdminRouterDeps): string[] {
	return REQUIRED_ONBOARDING_SETTINGS.filter((key) => {
		const value = deps.settingsStore!.get(key);
		return value === undefined || value === "";
	});
}

const registry = new AdminRouteRegistry()
	.route({
		method: "GET",
		pattern: /^\/api\/onboarding\/status$/u,
		auth: false,
		handler: async (ctx) => {
			if (!ctx.deps.settingsStore) {
				sendJson(ctx.response, 500, { error: "Settings store not configured" });
				return;
			}
			const missing = getMissingOnboardingSettings(ctx.deps);
			return { status: 200, body: { complete: missing.length === 0, missing } };
		},
	})
	.route<{ token?: string }>({
		method: "POST",
		pattern: /^\/api\/onboarding\/verify-token$/u,
		auth: false,
		parseBody: true,
		handler: async (ctx) => {
			const body = ctx.body as { token?: string };
			const token = body.token?.trim();
			if (!token) {
				throw new ValidationError("Token is required");
			}
			const gh = new GitHubServiceAdapter({ githubToken: token });
			const user = await gh.getAuthenticatedUser();
			if (!user) {
				sendJson(ctx.response, 400, {
					error: "Unable to verify token. Please check the token and try again.",
				});
				return;
			}
			return { status: 200, body: { username: user.login } };
		},
	})
	.route({
		method: "POST",
		pattern: /^\/api\/onboarding\/generate-secret$/u,
		auth: false,
		handler: async () => {
			const secret = randomBytes(96).toString("hex");
			return { status: 200, body: { secret } };
		},
	})
	.route<{ token?: string }>({
		method: "POST",
		pattern: /^\/api\/onboarding\/repos$/u,
		auth: false,
		parseBody: true,
		handler: async (ctx) => {
			const body = ctx.body as { token?: string };
			const token = body.token?.trim();
			if (!token) {
				throw new ValidationError("Token is required");
			}
			const gh = new GitHubServiceAdapter({ githubToken: token });
			const repos = await gh.listAccessibleRepositories();
			return { status: 200, body: { repositories: repos } };
		},
	})
	.route<{
		token?: string;
		username?: string;
		repos?: Array<{ owner: string; repo: string }>;
	}>({
		method: "POST",
		pattern: /^\/api\/onboarding\/init-workspaces$/u,
		auth: false,
		parseBody: true,
		handler: async (ctx) => {
			if (!ctx.deps.settingsStore) {
				sendJson(ctx.response, 500, { error: "Settings store not configured" });
				return;
			}
			const body = ctx.body as {
				token?: string;
				username?: string;
				repos?: Array<{ owner: string; repo: string }>;
			};
			const token = body.token?.trim();
			const username = body.username?.trim();
			const repos = body.repos ?? [];
			if (!token || !username) {
				throw new ValidationError("Token and username are required");
			}
			storeConfiguredRepositories(ctx.deps, repos);
			if (repos.length === 0) {
				return { status: 200, body: { initialized: [] } };
			}

			const workspacesDir = ctx.deps.settingsStore.getString("workspaces_dir", "./workspaces");
			const defaultBranch = ctx.deps.settingsStore.getString("default_branch", "main");
			const manager = new WorkspaceManager({
				workspacesDir,
				githubUsername: username,
				githubToken: token,
				defaultBranch,
			});

			const initialized: string[] = [];
			for (const repo of repos) {
				try {
					await manager.initializeRepo(repo.owner, repo.repo);
					initialized.push(`${repo.owner}/${repo.repo}`);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					process.stdout.write(`[onboarding] failed to initialize ${repo.owner}/${repo.repo}: ${message}\n`);
				}
			}
			return { status: 200, body: { initialized } };
		},
	})
	.route<Record<string, string>>({
		method: "POST",
		pattern: /^\/api\/onboarding$/u,
		auth: false,
		parseBody: true,
		handler: async (ctx) => {
			if (!ctx.deps.settingsStore) {
				sendJson(ctx.response, 500, { error: "Settings store not configured" });
				return;
			}
			const body = ctx.body as Record<string, string>;
			const missing = REQUIRED_ONBOARDING_SETTINGS.filter((key) => !body[key]?.trim());
			if (missing.length > 0) {
				sendJson(ctx.response, 400, {
					error: `Missing required fields: ${missing.join(", ")}`,
				});
				return;
			}
			for (const key of REQUIRED_ONBOARDING_SETTINGS) {
				ctx.deps.settingsStore.set(key, body[key].trim());
			}
			const storedMissing = getMissingOnboardingSettings(ctx.deps);
			const activated = storedMissing.length === 0;
			if (activated && ctx.deps.onOnboardingComplete) {
				setImmediate(() => {
					void Promise.resolve(ctx.deps.onOnboardingComplete?.()).catch((error) => {
						const message = error instanceof Error ? error.message : String(error);
						process.stderr.write(`[onboarding] activation failed: ${message}\n`);
					});
				});
			}
			return { status: 200, body: { success: true, activated, requiresRestart: [] } };
		},
	});

export async function handleOnboardingRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	pathname: string,
): Promise<boolean> {
	if (pathname === "/tarsadmin" || pathname === "/tarsadmin/") {
		if (!checkAdminTextAllowOnboarding(request, response, deps)) {
			return true;
		}
		sendHtml(response, 200, await adminHtml(deps.adminAssetsDir));
		return true;
	}

	if (pathname.startsWith("/tarsadmin/")) {
		if (!checkAdminTextAllowOnboarding(request, response, deps)) {
			return true;
		}
		await serveAdminAsset(response, deps.adminAssetsDir, pathname.slice("/tarsadmin/".length));
		return true;
	}

	return registry.handle(request, response, deps, pathname);
}
