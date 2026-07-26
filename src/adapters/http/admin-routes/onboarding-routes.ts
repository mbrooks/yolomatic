import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { adminHtml, serveAdminAsset } from "../asset-server.js";
import { sendHtml, sendJson } from "../response-helpers.js";
import {
	AdminRouteRegistry,
	ValidationError,
	checkAdminTextAllowOnboarding,
	getRequiredDeps,
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
	"admin_username",
	"admin_password",
	"github_event_mode",
];
const ONBOARDING_COMPLETE_SETTING = "onboarding_complete";

/**
 * Onboarding-related settings exposed to the wizard for pre-population.
 * Sensitive settings are reported as `{ configured }` so the stored secret
 * is never sent to the client; the wizard submits an empty value to preserve
 * the existing secret when the operator does not replace it.
 */
export const ONBOARDING_CONFIG_KEYS = [
	"admin_username",
	"admin_password",
	"github_token",
	"github_username",
	"github_event_mode",
	"github_poll_interval_ms",
	"webhook_secret",
] as const;

export const SENSITIVE_ONBOARDING_KEYS: ReadonlySet<string> = new Set([
	"github_token",
	"admin_password",
	"webhook_secret",
]);

export interface OnboardingConfigField {
	configured: boolean;
}

export type OnboardingConfigResponse = Record<string, string | OnboardingConfigField>;

export function buildOnboardingConfig(
	get: (key: string) => string | undefined,
): OnboardingConfigResponse {
	const result: OnboardingConfigResponse = {};
	for (const key of ONBOARDING_CONFIG_KEYS) {
		const value = get(key);
		if (SENSITIVE_ONBOARDING_KEYS.has(key)) {
			result[key] = { configured: value !== undefined && value !== "" };
		} else {
			result[key] = value ?? "";
		}
	}
	return result;
}

/**
 * Resolves the effective value for a sensitive onboarding setting: the
 * submitted value when provided, otherwise the currently configured value.
 * Returns undefined when neither is available so the caller can report it
 * as missing.
 */
export function resolveSecretSetting(
	get: (key: string) => string | undefined,
	key: string,
	submitted: string | undefined,
): string | undefined {
	const trimmed = submitted?.trim();
	if (trimmed) return trimmed;
	const existing = get(key);
	if (existing !== undefined && existing !== "") return existing;
	return undefined;
}

export const VALID_EVENT_MODES: readonly string[] = ["webhook", "polling", "both"];
export const MIN_POLL_INTERVAL_MS = 1000;

export function isValidEventMode(mode: string | undefined): boolean {
	return typeof mode === "string" && VALID_EVENT_MODES.includes(mode);
}

export function isPollingMode(mode: string | undefined): boolean {
	return mode === "polling" || mode === "both";
}

export function isWebhookMode(mode: string | undefined): boolean {
	return mode === "webhook" || mode === "both";
}

export function isValidPollIntervalMs(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const trimmed = raw.trim();
	if (!/^[0-9]+$/.test(trimmed)) return false;
	const value = Number.parseInt(trimmed, 10);
	return Number.isInteger(value) && value >= MIN_POLL_INTERVAL_MS;
}

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
	const missing = REQUIRED_ONBOARDING_SETTINGS.filter((key) => {
		const value = deps.settingsStore!.get(key);
		return value === undefined || value === "";
	});
	const modeRaw = deps.settingsStore!.get("github_event_mode")?.trim().toLowerCase();
	if (modeRaw && !isValidEventMode(modeRaw) && !missing.includes("github_event_mode")) {
		missing.push("github_event_mode");
	}
	if (isPollingMode(modeRaw) && !isValidPollIntervalMs(deps.settingsStore!.get("github_poll_interval_ms"))) {
		missing.push("github_poll_interval_ms");
	}
	if (isWebhookMode(modeRaw) && (deps.settingsStore!.get("webhook_secret") === undefined || deps.settingsStore!.get("webhook_secret") === "")) {
		missing.push("webhook_secret");
	}
	if (deps.settingsStore!.get(ONBOARDING_COMPLETE_SETTING) !== "true") {
		missing.push(ONBOARDING_COMPLETE_SETTING);
	}
	return missing;
}

const registry = new AdminRouteRegistry()
	.route({
		method: "GET",
		pattern: /^\/api\/onboarding\/status$/u,
		auth: false,
		requiresDeps: ["settingsStore"],
		handler: async (ctx) => {
			const settingsDeps = {
				...ctx.deps,
				...getRequiredDeps(ctx.deps, ["settingsStore"]),
			};
			const missing = getMissingOnboardingSettings(settingsDeps);
			return { status: 200, body: { complete: missing.length === 0, missing } };
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/onboarding\/config$/u,
		auth: false,
		requiresDeps: ["settingsStore"],
		handler: async (ctx) => {
			const { settingsStore } = getRequiredDeps(ctx.deps, ["settingsStore"]);
			return { status: 200, body: buildOnboardingConfig((key) => settingsStore.get(key)) };
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
		requiresDeps: ["settingsStore"],
		handler: async (ctx) => {
			const { settingsStore } = getRequiredDeps(ctx.deps, ["settingsStore"]);
			const body = ctx.body as { token?: string };
			// The wizard submits an empty token when the GitHub PAT is already
			// configured (protected). Fall back to the stored value so the
			// operator can still fetch repositories without re-entering the
			// secret.
			const token = resolveSecretSetting((k) => settingsStore.get(k), "github_token", body.token);
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
		requiresDeps: ["settingsStore"],
		handler: async (ctx) => {
			const settingsDeps = {
				...ctx.deps,
				...getRequiredDeps(ctx.deps, ["settingsStore"]),
			};
			const body = ctx.body as {
				token?: string;
				username?: string;
				repos?: Array<{ owner: string; repo: string }>;
			};
			// The wizard submits an empty token when the GitHub PAT is already
			// configured (protected). Fall back to the stored value so the
			// operator can still initialize workspaces without re-entering the
			// secret. The username is non-sensitive and normally pre-populated,
			// but fall back to the stored value as a safety net.
			const token = resolveSecretSetting((k) => settingsDeps.settingsStore.get(k), "github_token", body.token);
			const username = body.username?.trim() || settingsDeps.settingsStore.get("github_username")?.trim();
			const repos = body.repos ?? [];
			if (!token || !username) {
				throw new ValidationError("Token and username are required");
			}
			storeConfiguredRepositories(settingsDeps, repos);
			if (repos.length === 0) {
				return { status: 200, body: { initialized: [] } };
			}

			const workspacesDir = settingsDeps.settingsStore.getString("workspaces_dir", "./workspaces");
			const defaultBranch = settingsDeps.settingsStore.getString("default_branch", "main");
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
		requiresDeps: ["settingsStore"],
		handler: async (ctx) => {
			const { settingsStore } = getRequiredDeps(ctx.deps, ["settingsStore"]);
			const body = ctx.body as Record<string, string>;
			const resolveSecret = (key: string): string | undefined =>
				resolveSecretSetting((k) => settingsStore.get(k), key, body[key]);
			const githubToken = resolveSecret("github_token");
			const adminPassword = resolveSecret("admin_password");
			const webhookSecret = resolveSecret("webhook_secret");
			const missing: string[] = [];
			for (const key of REQUIRED_ONBOARDING_SETTINGS) {
				if (key === "github_token") {
					if (!githubToken) missing.push(key);
				} else if (key === "admin_password") {
					if (!adminPassword) missing.push(key);
				} else if (!body[key]?.trim()) {
					missing.push(key);
				}
			}
			if (missing.length > 0) {
				sendJson(ctx.response, 400, {
					error: `Missing required fields: ${missing.join(", ")}`,
				});
				return;
			}
			const eventMode = body.github_event_mode.trim().toLowerCase();
			if (!isValidEventMode(eventMode)) {
				sendJson(ctx.response, 400, {
					error: `github_event_mode must be one of: ${VALID_EVENT_MODES.join(", ")}`,
				});
				return;
			}
			if (isWebhookMode(eventMode) && !webhookSecret) {
				sendJson(ctx.response, 400, {
					error: "Missing required fields: webhook_secret",
				});
				return;
			}
			if (isPollingMode(eventMode)) {
				if (!isValidPollIntervalMs(body.github_poll_interval_ms)) {
					sendJson(ctx.response, 400, {
						error: `github_poll_interval_ms must be a whole number of at least ${MIN_POLL_INTERVAL_MS}`,
					});
					return;
				}
			}
			settingsStore.set("github_token", githubToken!);
			settingsStore.set("github_username", body.github_username.trim());
			settingsStore.set("admin_username", body.admin_username.trim());
			settingsStore.set("admin_password", adminPassword!);
			settingsStore.set("github_event_mode", eventMode);
			if (isWebhookMode(eventMode)) {
				settingsStore.set("webhook_secret", webhookSecret!);
			}
			if (isPollingMode(eventMode)) {
				settingsStore.set("github_poll_interval_ms", String(Number.parseInt(body.github_poll_interval_ms.trim(), 10)));
			}
			settingsStore.set(ONBOARDING_COMPLETE_SETTING, "true");
			const storedMissing = getMissingOnboardingSettings({
				...ctx.deps,
				settingsStore,
			});
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
