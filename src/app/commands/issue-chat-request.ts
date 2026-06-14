import type { CreatedIssue, GitHubService } from "../../ports/github-service.js";
import type { SkillStore } from "../../skills/store.js";
import type { RepoSkillService } from "../../skills/repo-skill-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { RepoContext } from "./issue-prompts.js";
import {
	chatIssueViaLLM,
	type IssueChatResponse as DraftIssueChatResponse,
	type IssueConversationMessage,
} from "./issue-chat.js";

export interface IssueChatRequestBody {
	owner?: string;
	repo?: string;
	privacyMode?: boolean;
	selectedTemplate?: string;
	context?: RepoContext;
	draft?: {
		title?: string;
		body?: string;
		labels?: string[];
		assignees?: string[];
	};
	messages?: Array<{ role?: "assistant" | "user"; text?: string }>;
}

export interface IssueChatResponse extends DraftIssueChatResponse {
	createdIssue?: CreatedIssue;
}

export interface IssueChatProgressEvent {
	type: "started" | "thinking" | "creating" | "completed" | "error";
	message: string;
	text?: string;
	done?: boolean;
	response?: IssueChatResponse;
}

export interface IssueChatRequestDeps {
	githubService?: GitHubService;
	skillStore?: SkillStore;
	repoSkillService?: RepoSkillService;
	taskControlService?: TaskControlService;
}

function normalizeMessages(messages: IssueChatRequestBody["messages"]): IssueConversationMessage[] {
	return Array.isArray(messages)
		? messages.filter((message): message is IssueConversationMessage =>
			(message.role === "assistant" || message.role === "user") && typeof message.text === "string",
		)
		: [];
}

export async function executeIssueChatRequest(
	deps: IssueChatRequestDeps,
	requestId: string | undefined,
	body: IssueChatRequestBody,
	onProgress?: (event: IssueChatProgressEvent) => void,
): Promise<IssueChatResponse> {
	const messages = normalizeMessages(body.messages);
	if (messages.length === 0) {
		throw new Error("Missing required field: messages");
	}

	onProgress?.({
		type: "started",
		message: "Thinking through the issue draft...",
	});

	const abortController = new AbortController();
	let resolveSession: ((session: import("@earendil-works/pi-coding-agent").AgentSession) => void) | undefined;
	const sessionPromise = new Promise<import("@earendil-works/pi-coding-agent").AgentSession>((resolve) => {
		resolveSession = resolve;
	});

	if (deps.taskControlService && requestId) {
		deps.taskControlService.register(
			requestId,
			() => abortController.abort(),
			async (msg) => {
				const session = await Promise.race([
					sessionPromise,
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error("steer timeout")), 5000)),
				]);
				await session.steer(msg);
			},
		);
	}

	try {
		const chatResult = await chatIssueViaLLM({
			owner: body.owner,
			repo: body.repo,
			draft: body.draft,
			context: body.context,
			options: { privacyMode: body.privacyMode ?? false, selectedTemplate: body.selectedTemplate },
			messages,
			onThinking: (chunk) => {
				onProgress?.({
					type: "thinking",
					message: chunk.text,
					text: chunk.text,
					done: chunk.done,
				});
			},
			skillStore: deps.skillStore,
			repoSkillService: deps.repoSkillService,
			abortSignal: abortController.signal,
			onSessionCreated: (session) => {
				resolveSession?.(session);
			},
		});

		if (chatResult.cancelled) {
			const response: IssueChatResponse = {
				...chatResult,
				createdIssue: undefined,
			};
			onProgress?.({
				type: "completed",
				message: chatResult.message,
				response,
			});
			return response;
		}

		if (!chatResult.shouldCreate) {
			onProgress?.({
				type: "completed",
				message: chatResult.message,
				response: chatResult,
			});
			return chatResult;
		}

		if (!deps.githubService) {
			throw new Error("GitHub service not configured");
		}

		if (!chatResult.owner || !chatResult.repo || !chatResult.draft.title) {
			const response: IssueChatResponse = {
				...chatResult,
				readyToCreate: false,
				shouldCreate: false,
				message: "I still need the repository and a clear title before I can create the issue.",
			};
			onProgress?.({
				type: "completed",
				message: response.message,
				response,
			});
			return response;
		}

		onProgress?.({
			type: "creating",
			message: `Creating issue in ${chatResult.owner}/${chatResult.repo}...`,
		});

		const createdIssue = await deps.githubService.createIssue(
			chatResult.owner,
			chatResult.repo,
			chatResult.draft.title,
			chatResult.draft.body,
			chatResult.draft.labels,
			chatResult.draft.assignees,
		);
		const response: IssueChatResponse = {
			...chatResult,
			createdIssue: {
				number: createdIssue.number,
				html_url: createdIssue.html_url,
			},
		};
		onProgress?.({
			type: "completed",
			message: response.message,
			response,
		});
		return response;
	} finally {
		if (deps.taskControlService && requestId) {
			deps.taskControlService.unregister(requestId);
		}
	}
}
