import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readBody } from "../../../webhook/http-utils.js";
import { adminHtml, serveAdminAsset } from "../asset-server.js";
import { sendHtml, sendJson } from "../response-helpers.js";
import {
	checkAdminTextAllowOnboarding,
	type AdminRouterDeps,
} from "../admin-router-shared.js";
import { GitHubServiceAdapter } from "../../../adapters/github/github-service-adapter.js";
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
	const configured = repos
		.map((repo) => ({
			owner: repo.owner.trim(),
			repo: repo.repo.trim(),
		}))
		.filter((repo) => repo.owner && repo.repo);
	const seen = new Set<string>();
	const unique = configured.filter((repo) => {
		const key = `${repo.owner}/${repo.repo}`.toLowerCase();
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
	deps.settingsStore!.set("configured_repositories", JSON.stringify(unique));
}

function getMissingOnboardingSettings(deps: AdminRouterDeps): string[] {
	return REQUIRED_ONBOARDING_SETTINGS.filter((key) => {
		const value = deps.settingsStore!.get(key);
		return value === undefined || value === "";
	});
}

export async function handleOnboardingRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	pathname: string,
): Promise<boolean> {
	if (request.method === "GET" && pathname === "/api/onboarding/status") {
		if (!deps.settingsStore) {
			sendJson(response, 500, { error: "Settings store not configured" });
			return true;
		}
		const missing = getMissingOnboardingSettings(deps);
		sendJson(response, 200, { complete: missing.length === 0, missing });
		return true;
	}

	if (request.method === "POST" && pathname === "/api/onboarding/verify-token") {
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as {
				token?: string;
			};
			const token = body.token?.trim();
			if (!token) {
				sendJson(response, 400, { error: "Token is required" });
				return true;
			}
			const gh = new GitHubServiceAdapter({ githubToken: token });
			const user = await gh.getAuthenticatedUser();
			if (!user) {
				sendJson(response, 400, { error: "Unable to verify token. Please check the token and try again." });
				return true;
			}
			sendJson(response, 200, { username: user.login });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 400, { error: message });
		}
		return true;
	}

	if (request.method === "POST" && pathname === "/api/onboarding/generate-secret") {
		const secret = randomBytes(96).toString("hex");
		sendJson(response, 200, { secret });
		return true;
	}

	if (request.method === "POST" && pathname === "/api/onboarding/repos") {
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as {
				token?: string;
			};
			const token = body.token?.trim();
			if (!token) {
				sendJson(response, 400, { error: "Token is required" });
				return true;
			}
			const gh = new GitHubServiceAdapter({ githubToken: token });
			const repos = await gh.listAccessibleRepositories();
			sendJson(response, 200, { repositories: repos });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 400, { error: message });
		}
		return true;
	}

	if (request.method === "POST" && pathname === "/api/onboarding/init-workspaces") {
		if (!deps.settingsStore) {
			sendJson(response, 500, { error: "Settings store not configured" });
			return true;
		}
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as {
				token?: string;
				username?: string;
				repos?: Array<{ owner: string; repo: string }>;
			};
			const token = body.token?.trim();
			const username = body.username?.trim();
			const repos = body.repos ?? [];
			if (!token || !username) {
				sendJson(response, 400, { error: "Token and username are required" });
				return true;
			}
			storeConfiguredRepositories(deps, repos);
			if (repos.length === 0) {
				sendJson(response, 200, { initialized: [] });
				return true;
			}

			const workspacesDir = deps.settingsStore.getString("workspaces_dir", "./workspaces");
			const defaultBranch = deps.settingsStore.getString("default_branch", "main");
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
			sendJson(response, 200, { initialized });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 400, { error: message });
		}
		return true;
	}

	if (request.method === "POST" && pathname === "/api/onboarding") {
		if (!deps.settingsStore) {
			sendJson(response, 500, { error: "Settings store not configured" });
			return true;
		}
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as Record<
				string,
				string
			>;
			const missing = REQUIRED_ONBOARDING_SETTINGS.filter((key) => !body[key]?.trim());
			if (missing.length > 0) {
				sendJson(response, 400, {
					error: `Missing required fields: ${missing.join(", ")}`,
				});
				return true;
			}
			for (const key of REQUIRED_ONBOARDING_SETTINGS) {
				deps.settingsStore.set(key, body[key].trim());
			}
			const storedMissing = getMissingOnboardingSettings(deps);
			const activated = storedMissing.length === 0;
			sendJson(response, 200, { success: true, activated, requiresRestart: [] });
			if (activated && deps.onOnboardingComplete) {
				setImmediate(() => {
					void Promise.resolve(deps.onOnboardingComplete?.()).catch((error) => {
						const message = error instanceof Error ? error.message : String(error);
						process.stderr.write(`[onboarding] activation failed: ${message}\n`);
					});
				});
			}
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
		await serveAdminAsset(
			response,
			deps.adminAssetsDir,
			pathname.slice("/tarsadmin/".length),
		);
		return true;
	}

	return false;
}
