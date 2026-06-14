import { describe, expect, it, vi } from "vitest";
import type { GitHubService } from "../../ports/github-service.js";
import { executeIssueChatRequest } from "./issue-chat-request.js";

vi.mock("./issue-chat.js", () => ({
	chatIssueViaLLM: vi.fn(async () => ({
		shouldCreate: false,
		draft: { title: "", body: "", labels: [], assignees: [] },
		message: "",
		owner: "",
		repo: "",
		readyToCreate: false,
	})),
}));

describe("executeIssueChatRequest", () => {
	const githubService = {
		createIssue: vi.fn(async () => ({ number: 99, html_url: "https://github.com/mbrooks/tars/issues/99" })),
	} as Pick<GitHubService, "createIssue"> as GitHubService;

	it("rejects missing messages", async () => {
		await expect(executeIssueChatRequest({ githubService }, undefined, {})).rejects.toThrow("Missing required field: messages");
	});

	it("filters invalid messages before invoking the LLM", async () => {
		const { chatIssueViaLLM } = await import("./issue-chat.js");
		vi.mocked(chatIssueViaLLM).mockResolvedValueOnce({
			shouldCreate: false,
			owner: "mbrooks",
			repo: "tars",
			draft: { title: "Title", body: "Body", labels: [], assignees: [] },
			message: "Draft ready",
			readyToCreate: true,
		});

		const response = await executeIssueChatRequest(
			{ githubService },
			undefined,
			{
				messages: [
					{ role: "user", text: "hello" },
					{ role: "system" as never, text: "skip me" },
					{ role: "assistant" },
				],
			},
		);

		expect(response.message).toBe("Draft ready");
		expect(chatIssueViaLLM).toHaveBeenCalledWith(expect.objectContaining({
			messages: [{ role: "user", text: "hello" }],
		}));
	});

	it("rejects create requests when GitHub service is missing", async () => {
		const { chatIssueViaLLM } = await import("./issue-chat.js");
		vi.mocked(chatIssueViaLLM).mockResolvedValueOnce({
			shouldCreate: true,
			owner: "mbrooks",
			repo: "tars",
			draft: { title: "Chat Title", body: "Chat Body", labels: [], assignees: [] },
			message: "Create it",
			readyToCreate: true,
		});

		await expect(
			executeIssueChatRequest(
				{},
				undefined,
				{ messages: [{ role: "user", text: "create it" }] },
			),
		).rejects.toThrow("GitHub service not configured");
	});

	it("returns non-create chat responses and emits completion progress", async () => {
		const { chatIssueViaLLM } = await import("./issue-chat.js");
		vi.mocked(chatIssueViaLLM).mockResolvedValueOnce({
			shouldCreate: false,
			owner: "mbrooks",
			repo: "tars",
			draft: { title: "Chat Title", body: "Chat Body", labels: [], assignees: [] },
			message: "Draft ready",
			readyToCreate: true,
		});
		const onProgress = vi.fn();

		const response = await executeIssueChatRequest(
			{ githubService },
			undefined,
			{ messages: [{ role: "user", text: "draft it" }] },
			onProgress,
		);

		expect(response.shouldCreate).toBe(false);
		expect(onProgress).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ type: "started" }),
		);
		expect(onProgress).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				type: "completed",
				message: "Draft ready",
				response: expect.objectContaining({ shouldCreate: false }),
			}),
		);
	});

	it("forwards LLM thinking chunks as progress events", async () => {
		const { chatIssueViaLLM } = await import("./issue-chat.js");
		vi.mocked(chatIssueViaLLM).mockImplementationOnce(async (input) => {
			input.onThinking?.({ text: "reading context", done: false });
			input.onThinking?.({ text: "reading context and labels", done: true });
			return {
				shouldCreate: false,
				owner: "mbrooks",
				repo: "tars",
				draft: { title: "Chat Title", body: "Chat Body", labels: [], assignees: [] },
				message: "Draft ready",
				readyToCreate: true,
			};
		});
		const onProgress = vi.fn();

		await executeIssueChatRequest(
			{ githubService },
			undefined,
			{ messages: [{ role: "user", text: "draft it" }] },
			onProgress,
		);

		expect(onProgress).toHaveBeenNthCalledWith(
			2,
			{
				type: "thinking",
				message: "reading context",
				text: "reading context",
				done: false,
			},
		);
		expect(onProgress).toHaveBeenNthCalledWith(
			3,
			{
				type: "thinking",
				message: "reading context and labels",
				text: "reading context and labels",
				done: true,
			},
		);
		expect(onProgress).toHaveBeenNthCalledWith(
			4,
			expect.objectContaining({ type: "completed", message: "Draft ready" }),
		);
	});

	it("emits progress updates when creation is incomplete", async () => {
		const { chatIssueViaLLM } = await import("./issue-chat.js");
		vi.mocked(chatIssueViaLLM).mockResolvedValueOnce({
			shouldCreate: true,
			owner: "mbrooks",
			repo: "",
			draft: { title: "", body: "Body", labels: [], assignees: [] },
			message: "Need more info",
			readyToCreate: false,
		});
		const onProgress = vi.fn();

		const response = await executeIssueChatRequest(
			{ githubService },
			undefined,
			{ messages: [{ role: "user", text: "create it" }] },
			onProgress,
		);

		expect(response.shouldCreate).toBe(false);
		expect(response.readyToCreate).toBe(false);
		expect(onProgress).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ type: "started" }),
		);
		expect(onProgress).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				type: "completed",
				response: expect.objectContaining({ readyToCreate: false, shouldCreate: false }),
			}),
		);
	});

	it("creates the issue when the draft is ready", async () => {
		const { chatIssueViaLLM } = await import("./issue-chat.js");
		vi.mocked(chatIssueViaLLM).mockResolvedValueOnce({
			shouldCreate: true,
			owner: "mbrooks",
			repo: "tars",
			draft: { title: "Chat Title", body: "Chat Body", labels: ["bug"], assignees: ["mbrooks"] },
			message: "Created",
			readyToCreate: true,
		});
		const onProgress = vi.fn();

		const response = await executeIssueChatRequest(
			{ githubService },
			undefined,
			{ messages: [{ role: "user", text: "create it" }] },
			onProgress,
		);

		expect(githubService.createIssue).toHaveBeenCalledWith(
			"mbrooks",
			"tars",
			"Chat Title",
			"Chat Body",
			["bug"],
			["mbrooks"],
		);
		expect(response.createdIssue).toEqual({
			number: 99,
			html_url: "https://github.com/mbrooks/tars/issues/99",
		});
		expect(onProgress).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				type: "creating",
				message: "Creating issue in mbrooks/tars...",
			}),
		);
		expect(onProgress).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({
				type: "completed",
				response: expect.objectContaining({
					createdIssue: {
						number: 99,
						html_url: "https://github.com/mbrooks/tars/issues/99",
					},
				}),
			}),
		);
	});

	it("registers with TaskControlService when requestId is provided", async () => {
		const { chatIssueViaLLM } = await import("./issue-chat.js");
		vi.mocked(chatIssueViaLLM).mockResolvedValueOnce({
			shouldCreate: false,
			owner: "mbrooks",
			repo: "tars",
			draft: { title: "Title", body: "Body", labels: [], assignees: [] },
			message: "Draft ready",
			readyToCreate: true,
		});

		const taskControlService = {
			register: vi.fn(),
			unregister: vi.fn(),
			cancel: vi.fn(),
			isActive: vi.fn(),
			steer: vi.fn(),
			isDraining: vi.fn(),
			setDraining: vi.fn(),
		};

		await executeIssueChatRequest(
			{ githubService, taskControlService },
			"req-123",
			{ messages: [{ role: "user", text: "draft it" }] },
		);

		expect(taskControlService.register).toHaveBeenCalledWith(
			"req-123",
			expect.any(Function),
			expect.any(Function),
		);
		expect(taskControlService.unregister).toHaveBeenCalledWith("req-123");
	});

	it("steers an active issue chat via the registered steer callback", async () => {
		const { chatIssueViaLLM } = await import("./issue-chat.js");
		const steerMock = vi.fn();
		const sessionMock = {
			steer: steerMock,
		};
		vi.mocked(chatIssueViaLLM).mockImplementationOnce(async (input) => {
			// Simulate the session being created and exposed via onSessionCreated
			input.onSessionCreated?.(sessionMock as never);
			return {
				shouldCreate: false,
				owner: "mbrooks",
				repo: "tars",
				draft: { title: "Title", body: "Body", labels: [], assignees: [] },
				message: "Draft ready",
				readyToCreate: true,
			};
		});

		const taskControlService = {
			register: vi.fn(),
			unregister: vi.fn(),
			cancel: vi.fn(),
			isActive: vi.fn(),
			steer: vi.fn(),
			isDraining: vi.fn(),
			setDraining: vi.fn(),
		};

		const requestPromise = executeIssueChatRequest(
			{ githubService, taskControlService },
			"req-steer",
			{ messages: [{ role: "user", text: "draft it" }] },
		);

		// Wait a tick so registration happens
		await Promise.resolve();

		// Extract the registered steer callback and invoke it
		const registerCall = taskControlService.register.mock.calls.find(
			(call) => call[0] === "req-steer",
		);
		expect(registerCall).toBeDefined();
		const steerCallback = registerCall![2] as (msg: string) => Promise<void>;
		await steerCallback("focus on performance");

		expect(steerMock).toHaveBeenCalledWith("focus on performance");
		await requestPromise;
	});

	it("returns cancelled response when chat is aborted", async () => {
		const { chatIssueViaLLM } = await import("./issue-chat.js");
		vi.mocked(chatIssueViaLLM).mockResolvedValueOnce({
			shouldCreate: false,
			owner: "",
			repo: "",
			draft: { title: "", body: "", labels: [], assignees: [] },
			message: "Stopped by user.",
			readyToCreate: false,
			cancelled: true,
		});
		const onProgress = vi.fn();

		const response = await executeIssueChatRequest(
			{ githubService },
			undefined,
			{ messages: [{ role: "user", text: "draft it" }] },
			onProgress,
		);

		expect(response.cancelled).toBe(true);
		expect(onProgress).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: "completed",
				message: "Stopped by user.",
			}),
		);
	});
});
