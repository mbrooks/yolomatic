import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../../../webhook/http-utils.js";
import { adminHtml, serveAdminAsset } from "../asset-server.js";
import { sendHtml, sendJson } from "../response-helpers.js";
import {
	checkAdminTextAllowOnboarding,
	type AdminRouterDeps,
} from "../admin-router-shared.js";

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
		const required = [
			"github_token",
			"github_username",
			"webhook_secret",
			"admin_username",
			"admin_password",
		];
		const missing = required.filter((key) => {
			const value = deps.settingsStore!.get(key);
			return value === undefined || value === "";
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
			const body = JSON.parse((await readBody(request)).toString("utf8")) as Record<
				string,
				string
			>;
			const required = [
				"github_token",
				"github_username",
				"webhook_secret",
				"admin_username",
				"admin_password",
			];
			const missing = required.filter((key) => !body[key]?.trim());
			if (missing.length > 0) {
				sendJson(response, 400, {
					error: `Missing required fields: ${missing.join(", ")}`,
				});
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
		await serveAdminAsset(
			response,
			deps.adminAssetsDir,
			pathname.slice("/tarsadmin/".length),
		);
		return true;
	}

	return false;
}
