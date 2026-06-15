import type { IncomingMessage, ServerResponse } from "node:http";
import { generateIssueViaLLM } from "../../../app/commands/generate-issue.js";
import type { RepoContext } from "../../../app/commands/issue-prompts.js";
import { sendJson } from "../response-helpers.js";
import {
	AdminRouteRegistry,
	ValidationError,
	type AdminRouterDeps,
} from "../admin-router-shared.js";
import {
	executeIssueChatRequest,
	type IssueChatRequestBody,
} from "../../../app/commands/issue-chat-request.js";

const registry = new AdminRouteRegistry()
	.route<{
		owner?: string;
		repo?: string;
		prompt?: string;
		privacyMode?: boolean;
		selectedTemplate?: string;
		context?: RepoContext;
	}>({
		method: "POST",
		pattern: /^\/api\/issues\/generate$/u,
		parseBody: true,
		parseErrorStatus: 500,
		required: ["owner", "repo", "prompt"],
		handler: async (ctx) => {
			const body = ctx.body as {
				owner: string;
				repo: string;
				prompt: string;
				privacyMode?: boolean;
				selectedTemplate?: string;
				context?: RepoContext;
			};
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
			return { status: 200, body: generated };
		},
	})
	.route<IssueChatRequestBody>({
		method: "POST",
		pattern: /^\/api\/issues\/chat$/u,
		parseBody: true,
		parseErrorStatus: 500,
		handler: async (ctx) => {
			const body = ctx.body as IssueChatRequestBody;
			if (!Array.isArray(body.messages) || body.messages.length === 0) {
				throw new ValidationError("Missing required field: messages");
			}
			return { status: 200, body: await executeIssueChatRequest(ctx.deps, undefined, body) };
		},
	})
	.route<{
		owner?: string;
		repo?: string;
		title?: string;
		body?: string;
		labels?: string[];
		assignees?: string[];
	}>({
		method: "POST",
		pattern: /^\/api\/issues$/u,
		parseBody: true,
		parseErrorStatus: 500,
		required: ["owner", "repo", "title"],
		handler: async (ctx) => {
			if (!ctx.deps.githubService) {
				sendJson(ctx.response, 500, { error: "GitHub service not configured" });
				return;
			}
			const body = ctx.body as {
				owner: string;
				repo: string;
				title: string;
				body?: string;
				labels?: string[];
				assignees?: string[];
			};
			const issue = await ctx.deps.githubService.createIssue(
				body.owner,
				body.repo,
				body.title,
				body.body || "",
				body.labels,
				body.assignees,
			);
			return { status: 201, body: issue };
		},
	});

export async function handleIssueRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	pathname: string,
): Promise<boolean> {
	return registry.handle(request, response, deps, pathname);
}
