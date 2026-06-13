import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../../../webhook/http-utils.js";
import { sendJson } from "../response-helpers.js";
import {
	checkAdminJson,
	mapResultToStatus,
	type AdminRouterDeps,
} from "../admin-router-shared.js";

export async function handleRepoRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	pathname: string,
): Promise<boolean> {
	const repoContextMatch = /^\/api\/repos\/([^/]+)\/([^/]+)\/context$/u.exec(pathname);
	if (repoContextMatch && request.method === "GET") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.githubService) {
			sendJson(response, 500, { error: "GitHub service not configured" });
			return true;
		}
		const [, owner, repo] = repoContextMatch;
		try {
			const [labels, templates, recentCommits, relatedIssues] = await Promise.all([
				deps.githubService.listLabels(owner, repo),
				deps.githubService.getIssueTemplates(owner, repo),
				deps.githubService.listRecentCommits(owner, repo, 5),
				deps.githubService.listRelatedIssues(
					owner,
					repo,
					"bug OR feature OR enhancement",
					5,
				),
			]);
			sendJson(response, 200, {
				labels,
				templates,
				recentCommits,
				relatedIssues,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	const repoIssuesMatch = /^\/api\/repos\/([^/]+)\/([^/]+)\/issues$/u.exec(pathname);
	if (repoIssuesMatch && request.method === "GET") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.githubService) {
			sendJson(response, 500, { error: "GitHub service not configured" });
			return true;
		}
		const [, owner, repo] = repoIssuesMatch;
		try {
			const issues = await deps.githubService.listOpenIssues(owner, repo);
			sendJson(response, 200, { issues });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	const assignMatch =
		/^\/api\/repos\/([^/]+)\/([^/]+)\/issues\/(-?\d+)\/assign$/u.exec(pathname);
	if (assignMatch && request.method === "POST") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.githubService) {
			sendJson(response, 500, { error: "GitHub service not configured" });
			return true;
		}
		if (!deps.settingsStore) {
			sendJson(response, 500, { error: "Settings store not configured" });
			return true;
		}
		const [, owner, repo, issueNumberStr] = assignMatch;
		const issueNumber = Number.parseInt(issueNumberStr, 10);
		if (Number.isNaN(issueNumber)) {
			sendJson(response, 400, { error: "Invalid issue number" });
			return true;
		}
		const tarsUsername = deps.settingsStore.get("github_username");
		if (!tarsUsername) {
			sendJson(response, 500, { error: "TARS GitHub username not configured" });
			return true;
		}
		try {
			await deps.githubService.updateIssueAssignees(owner, repo, issueNumber, [
				tarsUsername,
			]);
			sendJson(response, 200, { assigned: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[webhook] assign error: ${message}\n`);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	const startSessionMatch =
		/^\/api\/repos\/([^/]+)\/([^/]+)\/issues\/(-?\d+)\/start-session$/u.exec(pathname);
	if (startSessionMatch && request.method === "POST") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.githubService) {
			sendJson(response, 500, { error: "GitHub service not configured" });
			return true;
		}
		if (!deps.settingsStore) {
			sendJson(response, 500, { error: "Settings store not configured" });
			return true;
		}
		if (!deps.startIssueSession) {
			sendJson(response, 500, { error: "Session executor not configured" });
			return true;
		}
		const [, owner, repo, issueNumberStr] = startSessionMatch;
		const issueNumber = Number.parseInt(issueNumberStr, 10);
		if (Number.isNaN(issueNumber)) {
			sendJson(response, 400, { error: "Invalid issue number" });
			return true;
		}
		const tarsUsername = deps.settingsStore.get("github_username");
		if (!tarsUsername) {
			sendJson(response, 500, { error: "TARS GitHub username not configured" });
			return true;
		}
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as {
				title?: string;
				body?: string;
				labels?: string[];
			};
			if (!body.title) {
				sendJson(response, 400, { error: "Missing required field: title" });
				return true;
			}
			const result = await deps.startIssueSession.execute(
				owner,
				repo,
				issueNumber,
				body.title,
				body.body ?? "",
				body.labels ?? [],
			);
			if (!result.success) {
				sendJson(response, mapResultToStatus(result.code), { error: result.message });
				return true;
			}
			sendJson(response, 200, result.data);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[webhook] start-session error: ${message}\n`);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	return false;
}
