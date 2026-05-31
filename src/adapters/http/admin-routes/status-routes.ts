import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../../../webhook/http-utils.js";
import { sendJson } from "../response-helpers.js";
import {
	checkAdminJson,
	mapResultToStatus,
	type AdminRouterDeps,
} from "../admin-router-shared.js";

export async function handleStatusRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	pathname: string,
): Promise<boolean> {
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
			const workingSessions = result.data.sessions.filter(
				(session) => session.status === "working",
			);
			sendJson(response, 200, {
				working: workingSessions.length > 0,
				count: workingSessions.length,
				sessions: workingSessions.map((session) => ({
					owner: session.owner,
					repo: session.repo,
					issueNumber: session.issueNumber,
					status: session.status,
					lastActivity: session.lastActivity,
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
			const body = JSON.parse((await readBody(request)).toString("utf8")) as {
				enabled?: boolean;
			};
			const enabled = body.enabled === true;
			deps.taskController.setDraining(enabled);
			process.stdout.write(
				`[webhook] maintenance mode ${enabled ? "enabled" : "disabled"}\n`,
			);
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

	return false;
}
