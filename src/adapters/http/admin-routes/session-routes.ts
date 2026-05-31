import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../../../webhook/http-utils.js";
import type { SessionCommand } from "../../../app/commands/run-session-command.js";
import { sendJson } from "../response-helpers.js";
import {
	checkAdminJson,
	mapResultToStatus,
	type AdminRouterDeps,
} from "../admin-router-shared.js";

export async function handleSessionRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	requestUrl: URL,
	pathname: string,
): Promise<boolean> {
	if (request.method === "GET" && pathname.startsWith("/api/sessions/")) {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}

		const logMatch = /^\/api\/sessions\/([^/]+)\/([^/]+)\/(-?\d+)\/log$/u.exec(pathname);
		if (!logMatch) {
			sendJson(response, 404, { error: "Not found" });
			return true;
		}

		const [, owner, repo, issueNumberStr] = logMatch;
		const issueNumber = Number.parseInt(issueNumberStr, 10);
		if (Number.isNaN(issueNumber)) {
			sendJson(response, 400, { error: "Invalid issue number" });
			return true;
		}

		const since = requestUrl.searchParams.get("since") ?? undefined;
		try {
			const result = await deps.getSessionLog.execute(owner, repo, issueNumber, since);
			if (!result.success) {
				sendJson(response, mapResultToStatus(result.code), { error: result.message });
				return true;
			}
			sendJson(response, 200, result.data);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[webhook] log error: ${message}\n`);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	if (request.method === "POST" && pathname.startsWith("/api/sessions/")) {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}

		const commandMatch =
			/^\/api\/sessions\/([^/]+)\/([^/]+)\/(-?\d+)\/commands$/u.exec(pathname);
		if (!commandMatch) {
			sendJson(response, 404, { error: "Not found" });
			return true;
		}

		const [, owner, repo, issueNumberStr] = commandMatch;
		const issueNumber = Number.parseInt(issueNumberStr, 10);
		if (Number.isNaN(issueNumber)) {
			sendJson(response, 400, { error: "Invalid issue number" });
			return true;
		}

		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as {
				command?: SessionCommand;
				payload?: Record<string, unknown>;
			};
			if (!body.command) {
				sendJson(response, 400, { error: "Missing command" });
				return true;
			}
			const result = await deps.runSessionCommand.execute(
				owner,
				repo,
				issueNumber,
				body.command,
				body.payload,
			);
			if (!result.success) {
				sendJson(response, mapResultToStatus(result.code), { error: result.message });
				return true;
			}
			sendJson(response, 200, result.data);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[webhook] command error: ${message}\n`);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	return false;
}
