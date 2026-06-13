import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../../../webhook/http-utils.js";
import { generateIssueViaLLM } from "../../../app/commands/generate-issue.js";
import type { RepoContext } from "../../../app/commands/issue-prompts.js";
import { sendJson } from "../response-helpers.js";
import {
	checkAdminJson,
	type AdminRouterDeps,
} from "../admin-router-shared.js";
import {
	executeIssueChatRequest,
	type IssueChatRequestBody,
} from "../../../app/commands/issue-chat-request.js";

export async function handleIssueRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	pathname: string,
): Promise<boolean> {
	if (request.method === "POST" && pathname === "/api/issues/generate") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as {
				owner?: string;
				repo?: string;
				prompt?: string;
				privacyMode?: boolean;
				selectedTemplate?: string;
				context?: RepoContext;
			};
			if (!body.owner || !body.repo || !body.prompt) {
				sendJson(response, 400, {
					error: "Missing required fields: owner, repo, prompt",
				});
				return true;
			}
			const generated = await generateIssueViaLLM(
				body.owner,
				body.repo,
				body.prompt,
				body.context,
				{
					privacyMode: body.privacyMode ?? false,
					selectedTemplate: body.selectedTemplate,
				},
			);
			sendJson(response, 200, generated);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	if (request.method === "POST" && pathname === "/api/issues/chat") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as IssueChatRequestBody;
			if (!Array.isArray(body.messages) || body.messages.length === 0) {
				sendJson(response, 400, { error: "Missing required field: messages" });
				return true;
			}
			sendJson(response, 200, await executeIssueChatRequest(deps, undefined, body));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(
				response,
				message === "Missing required field: messages" ? 400 : 500,
				{ error: message },
			);
		}
		return true;
	}

	if (request.method === "POST" && pathname === "/api/issues") {
		if (!checkAdminJson(request, response, deps)) {
			return true;
		}
		if (!deps.githubService) {
			sendJson(response, 500, { error: "GitHub service not configured" });
			return true;
		}
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as {
				owner?: string;
				repo?: string;
				title?: string;
				body?: string;
				labels?: string[];
				assignees?: string[];
			};
			if (!body.owner || !body.repo || !body.title) {
				sendJson(response, 400, {
					error: "Missing required fields: owner, repo, title",
				});
				return true;
			}
			const issue = await deps.githubService.createIssue(
				body.owner,
				body.repo,
				body.title,
				body.body || "",
				body.labels,
				body.assignees,
			);
			sendJson(response, 201, issue);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	return false;
}
