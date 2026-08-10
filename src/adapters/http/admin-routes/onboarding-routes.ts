import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { adminHtml, serveAdminAsset } from "../asset-server.js";
import { sendHtml, sendJson } from "../response-helpers.js";
import {
	AdminRouteRegistry,
	ValidationError,
	checkAdminTextAllowOnboarding,
	getRequiredDeps,
	resolveAdminDefaultPage,
	resolveAdminPath,
	type AdminRouterDeps,
} from "../admin-router-shared.js";
import { GitHubServiceAdapter } from "../../../adapters/github/github-service-adapter.js";
import { WorkspaceManager } from "../../../workspace/manager.js";
import { DEFAULT_OLLAMA_CONTAINER_NAME } from "../../../ollama/signin-status.js";
import type { User } from "../../../users/store.js";

const REQUIRED_ONBOARDING_SETTINGS = [
	"github_token",
	"github_username",
	"github_event_mode",
];
const ONBOARDING_COMPLETE_SETTING = "onboarding_complete";
const ADMIN_USER_MISSING_KEY = "admin_user";

/**
 * Onboarding-related settings exposed to the wizard for pre-population.
 * The master admin account fields (`admin_full_name`, `admin_username`,
 * `admin_password`) are sourced from the `users` table rather than settings;
 * `admin_password` is reported as `{ configured }` so the stored hash is
 * never sent to the client.
 */
export const ONBOARDING_CONFIG_KEYS = [
	"github_token",
	"github_username",
	"github_event_mode",
	"github_poll_interval_ms",
	"webhook_secret",
	"pi_agent_provider",
	"pi_agent_model",
	"ollama_container_name",
	"openai_api_key",
] as const;

/** LLM provider values accepted by the onboarding submission handler. */
export const VALID_ONBOARDING_PROVIDERS: readonly string[] = ["ollama", "openai"];

export const SENSITIVE_ONBOARDING_KEYS: ReadonlySet<string> = new Set([
	"github_token",
	"webhook_secret",
	"openai_api_key",
]);

export interface OnboardingConfigField {
	configured: boolean;
}

export type OnboardingConfigResponse = Record<string, string | OnboardingConfigField>;

/**
 * Build the onboarding config payload shown to the wizard. Master admin
 * account fields come from `masterUser` (the first admin account); the
 * remaining settings are read via `get`. Sensitive settings are reported as
 * `{ configured }` rather than their stored value.
 */
export function buildOnboardingConfig(
	get: (key: string) => string | undefined,
	masterUser: User | null,
): OnboardingConfigResponse {
	const result: OnboardingConfigResponse = {
		admin_full_name: masterUser?.fullName ?? "",
		admin_username: masterUser?.username ?? "",
		admin_password: { configured: masterUser !== null },
	};
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
): Promise<void> {
	const store = deps.repositoryStore!;
	const operations: Promise<unknown>[] = [];
	for (const repo of repos) {
		const owner = repo.owner.trim();
		const name = repo.repo.trim();
		if (!owner || !name) {
			continue;
		}
		operations.push(store.upsert({ owner, repo: name }));
	}
	return Promise.all(operations).then(() => undefined);
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
	if (!deps.userStore!.hasAnySync()) {
		missing.push(ADMIN_USER_MISSING_KEY);
	}
	if (deps.settingsStore!.get(ONBOARDING_COMPLETE_SETTING) !== "true") {
		missing.push(ONBOARDING_COMPLETE_SETTING);
	}
	return missing;
}

/**
 * Create or refresh the master admin account from the wizard's submission.
 * When no admin user exists, a new master admin is created from the supplied
 * full name, username, and password. When a master admin already exists
 * (re-running onboarding), the existing account is updated in place — its
 * full name is replaced and its password is reset only when a new password is
 * supplied — rather than deleting existing users.
 */
function applyMasterAdmin(
	deps: AdminRouterDeps,
	fullName: string,
	username: string,
	password: string,
): void {
	const store = deps.userStore!;
	if (!store.hasAnySync()) {
		if (!fullName.trim() || !username.trim() || !password) {
			throw new ValidationError("Missing required fields: admin_full_name, admin_username, admin_password");
		}
		store.createSync({ fullName: fullName.trim(), username: username.trim(), password });
		return;
	}
	const existing = store.firstSync();
	if (!existing) {
		store.createSync({ fullName: fullName.trim(), username: username.trim(), password });
		return;
	}
	if (fullName.trim() && fullName.trim() !== existing.fullName) {
		store.updateFullNameSync(existing.id, fullName.trim());
	}
	if (password) {
		store.updatePasswordSync(existing.id, password);
	}
}

const registry = new AdminRouteRegistry()
	.route({
		method: "GET",
		pattern: /^\/api\/onboarding\/status$/u,
		auth: false,
		requiresDeps: ["settingsStore", "userStore"],
		handler: async (ctx) => {
			const settingsDeps = {
				...ctx.deps,
				...getRequiredDeps(ctx.deps, ["settingsStore", "userStore"]),
			};
			const missing = getMissingOnboardingSettings(settingsDeps);
			return { status: 200, body: { complete: missing.length === 0, missing } };
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/onboarding\/config$/u,
		auth: false,
		requiresDeps: ["settingsStore", "userStore"],
		handler: async (ctx) => {
			const { settingsStore, userStore } = getRequiredDeps(ctx.deps, ["settingsStore", "userStore"]);
			return { status: 200, body: buildOnboardingConfig((key) => settingsStore.get(key), userStore.firstSync()) };
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
			const token = resolveSecretSetting((k) => settingsStore.get(k), "github_token", body.token);
			if (!token) {
				throw new ValidationError("Token is required");
			}
			const gh = new GitHubServiceAdapter({ githubToken: token });
			const repos = await gh.listAccessibleRepositories();
			let configured: Array<{ owner: string; repo: string }> = [];
			if (ctx.deps.repositoryStore) {
				configured = (await ctx.deps.repositoryStore.list()).map((repo) => ({ owner: repo.owner, repo: repo.repo }));
			}
			return { status: 200, body: { repositories: repos, configured } };
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
		requiresDeps: ["settingsStore", "repositoryStore"],
		handler: async (ctx) => {
			const settingsDeps = {
				...ctx.deps,
				...getRequiredDeps(ctx.deps, ["settingsStore", "repositoryStore"]),
			};
			const body = ctx.body as {
				token?: string;
				username?: string;
				repos?: Array<{ owner: string; repo: string }>;
			};
			const token = resolveSecretSetting((k) => settingsDeps.settingsStore.get(k), "github_token", body.token);
			const username = body.username?.trim() || settingsDeps.settingsStore.get("github_username")?.trim();
			const repos = body.repos ?? [];
			if (!token || !username) {
				throw new ValidationError("Token and username are required");
			}
			await storeConfiguredRepositories(settingsDeps, repos);
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
	.route({
		method: "GET",
		pattern: /^\/api\/onboarding\/ollama-signin$/u,
		auth: false,
		requiresDeps: ["settingsStore", "ollamaSignInService"],
		handler: async (ctx) => {
			const { settingsStore, ollamaSignInService } = getRequiredDeps(ctx.deps, [
				"settingsStore",
				"ollamaSignInService",
			]);
			const containerName = settingsStore.getString(
				"ollama_container_name",
				DEFAULT_OLLAMA_CONTAINER_NAME,
			);
			const result = await ollamaSignInService.checkSignInStatus({ containerName });
			return { status: 200, body: result };
		},
	})
	.route<Record<string, string>>({
		method: "POST",
		pattern: /^\/api\/onboarding$/u,
		auth: false,
		parseBody: true,
		requiresDeps: ["settingsStore", "userStore"],
		handler: async (ctx) => {
			const { settingsStore, userStore } = getRequiredDeps(ctx.deps, ["settingsStore", "userStore"]);
			const body = ctx.body as Record<string, string>;
			const resolveSecret = (key: string): string | undefined =>
				resolveSecretSetting((k) => settingsStore.get(k), key, body[key]);
			const githubToken = resolveSecret("github_token");
			const webhookSecret = resolveSecret("webhook_secret");
			const missing: string[] = [];
			for (const key of REQUIRED_ONBOARDING_SETTINGS) {
				if (key === "github_token") {
					if (!githubToken) missing.push(key);
				} else if (!body[key]?.trim()) {
					missing.push(key);
				}
			}
			const hasMasterAdmin = userStore.hasAnySync();
			const adminFullName = body.admin_full_name?.trim() ?? "";
			const adminUsername = body.admin_username?.trim() ?? "";
			const adminPassword = body.admin_password?.trim() ?? "";
			if (!hasMasterAdmin) {
				if (!adminFullName) missing.push("admin_full_name");
				if (!adminUsername) missing.push("admin_username");
				if (!adminPassword) missing.push("admin_password");
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
			const providerRaw = body.pi_agent_provider?.trim();
			if (providerRaw && !VALID_ONBOARDING_PROVIDERS.includes(providerRaw)) {
				sendJson(ctx.response, 400, {
					error: `pi_agent_provider must be one of: ${VALID_ONBOARDING_PROVIDERS.join(", ")}`,
				});
				return;
			}
			applyMasterAdmin(ctx.deps, adminFullName, adminUsername, adminPassword);
			settingsStore.set("github_token", githubToken!);
			settingsStore.set("github_username", body.github_username.trim());
			settingsStore.set("github_event_mode", eventMode);
			if (isWebhookMode(eventMode)) {
				settingsStore.set("webhook_secret", webhookSecret!);
			}
			if (isPollingMode(eventMode)) {
				settingsStore.set("github_poll_interval_ms", String(Number.parseInt(body.github_poll_interval_ms.trim(), 10)));
			}
			if (providerRaw) {
				settingsStore.set("pi_agent_provider", providerRaw);
			}
			const modelValue = body.pi_agent_model?.trim();
			if (modelValue) {
				settingsStore.set("pi_agent_model", modelValue);
			}
			const containerValue = body.ollama_container_name?.trim();
			if (containerValue) {
				settingsStore.set("ollama_container_name", containerValue);
			}
			const openaiApiKey = resolveSecret("openai_api_key");
			if (openaiApiKey) {
				settingsStore.set("openai_api_key", openaiApiKey);
			}
			settingsStore.set(ONBOARDING_COMPLETE_SETTING, "true");
			const storedMissing = getMissingOnboardingSettings({
				...ctx.deps,
				settingsStore,
				userStore,
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
	const adminPath = resolveAdminPath(deps);
	const adminDefaultPage = resolveAdminDefaultPage(deps);

	if (adminPath === "/") {
		if (pathname === "/") {
			if (!checkAdminTextAllowOnboarding(request, response, deps)) {
				return true;
			}
			sendHtml(response, 200, await adminHtml(deps.adminAssetsDir, adminPath, adminDefaultPage));
			return true;
		}
	} else {
		if (pathname === adminPath || pathname === `${adminPath}/`) {
			if (!checkAdminTextAllowOnboarding(request, response, deps)) {
				return true;
			}
			sendHtml(response, 200, await adminHtml(deps.adminAssetsDir, adminPath, adminDefaultPage));
			return true;
		}

		if (pathname.startsWith(`${adminPath}/`)) {
			if (!checkAdminTextAllowOnboarding(request, response, deps)) {
				return true;
			}
			await serveAdminAsset(response, deps.adminAssetsDir, pathname.slice(`${adminPath}/`.length));
			return true;
		}
	}

	return registry.handle(request, response, deps, pathname);
}