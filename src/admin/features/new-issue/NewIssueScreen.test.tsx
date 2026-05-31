// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

import { NewIssueScreen } from "./NewIssueScreen.js";
import { webSocketManager } from "../../api/websocket.js";

function mockJsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const mockRepos = [
	{ owner: "mbrooks", repo: "tars", sessionCount: 5, activeCount: 2, cronCount: 0, lastActivity: "2024-01-01" },
	{ owner: "other", repo: "repo", sessionCount: 1, activeCount: 0, cronCount: 0, lastActivity: null },
];

describe("NewIssueScreen", () => {
	let fetchSpy: any;
	let subscribeStatusSpy: any;
	let onStatusChangeSpy: any;
	let requestIssueChatSpy: any;
	let connectionStatusSpy: any;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();

			if (url.includes("/api/repos/")) {
				return mockJsonResponse({
					labels: ["bug", "enhancement"],
					templates: [{ name: "Bug Report", body: "## Steps\n" }],
					recentCommits: ["abc123: fix"],
					relatedIssues: [{ number: 1, title: "Old", state: "closed" }],
				});
			}

			if (url.includes("/api/issues/chat")) {
				const body = JSON.parse(String(init?.body ?? "{}")) as {
					messages?: Array<{ role: string; text: string }>;
				};
				const lastUserMessage = [...(body.messages ?? [])].reverse().find((message) => message.role === "user")?.text ?? "";

				if (lastUserMessage.includes("something is broken") || lastUserMessage.includes("broken in mbrooks/tars")) {
					return mockJsonResponse({
						message: "I drafted the issue. If this is right, tell me to create it.",
						owner: "mbrooks",
						repo: "tars",
						draft: {
							title: "Generated Title",
							body: "Generated body",
							labels: ["bug"],
							assignees: [],
						},
						readyToCreate: true,
						shouldCreate: false,
					});
				}

				if (lastUserMessage === "create it") {
					return mockJsonResponse({
						message: "Creating the issue now.",
						owner: "mbrooks",
						repo: "tars",
						draft: {
							title: "Generated Title",
							body: "Generated body",
							labels: ["bug"],
							assignees: [],
						},
						readyToCreate: true,
						shouldCreate: true,
						createdIssue: { number: 42, html_url: "http://issue/42" },
					});
				}
			}

			if (url.includes("/api/issues") && !url.includes("/chat") && !url.includes("/generate")) {
				return mockJsonResponse({
					number: 99,
					html_url: "https://github.com/mbrooks/tars/issues/99",
				});
			}

			return mockJsonResponse({});
		});

		subscribeStatusSpy = vi.spyOn(webSocketManager, "subscribeStatus").mockImplementation(() => {
			return () => {};
		});
		onStatusChangeSpy = vi.spyOn(webSocketManager, "onStatusChange").mockImplementation(() => {
			return () => {};
		});
		requestIssueChatSpy = vi.spyOn(webSocketManager, "requestIssueChat");
		connectionStatusSpy = vi.spyOn(webSocketManager, "connectionStatus", "get").mockReturnValue("closed");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		subscribeStatusSpy.mockRestore();
		onStatusChangeSpy.mockRestore();
		requestIssueChatSpy.mockRestore();
		connectionStatusSpy.mockRestore();
	});

	it("shows repository selector when no prefill is provided", () => {
		render(<NewIssueScreen onBack={() => {}} repos={mockRepos} />);
		expect(screen.queryByText("Select a repository")).not.toBeNull();
		expect(screen.queryByText("mbrooks/tars")).not.toBeNull();
		expect(screen.queryByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.")).toBeNull();
	});

	it("skips selector when prefill owner and repo are provided", () => {
		render(<NewIssueScreen onBack={() => {}} prefillOwner="mbrooks" prefillRepo="tars" repos={mockRepos} />);
		expect(screen.queryByText("Select a repository")).toBeNull();
		expect(screen.queryByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.")).not.toBeNull();
		expect(screen.queryByText("Issue draft")).not.toBeNull();
	});

	it("auto-selects the only available repository and proceeds to chat", async () => {
		const singleRepo = [mockRepos[0]];
		render(<NewIssueScreen onBack={() => {}} repos={singleRepo} />);
		await waitFor(() => {
			expect(screen.queryByText("Select a repository")).toBeNull();
		});
		expect(screen.queryByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.")).not.toBeNull();
	});

	it("selects a repository from the selector and proceeds to chat", async () => {
		render(<NewIssueScreen onBack={() => {}} repos={mockRepos} />);
		expect(screen.queryByText("Select a repository")).not.toBeNull();
		const card = screen.getByText("mbrooks/tars");
		fireEvent.click(card);
		await waitFor(() => {
			expect(screen.queryByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.")).not.toBeNull();
		});
		expect(screen.queryByText("Select a repository")).toBeNull();
	});

	it("allows manual repository entry from the selector", async () => {
		render(<NewIssueScreen onBack={() => {}} repos={[]} />);
		expect(screen.queryByText("Select a repository")).not.toBeNull();
		const ownerInput = screen.getByLabelText("Repository owner") as HTMLInputElement;
		const repoInput = screen.getByLabelText("Repository name") as HTMLInputElement;
		fireEvent.change(ownerInput, { target: { value: "custom" } });
		fireEvent.change(repoInput, { target: { value: "repo" } });
		const continueBtn = screen.getByRole("button", { name: /Continue/ });
		fireEvent.click(continueBtn);
		await waitFor(() => {
			expect(screen.queryByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.")).not.toBeNull();
		});
	});

	it("renders the conversational interface when repo is known", () => {
		render(<NewIssueScreen onBack={() => {}} prefillOwner="mbrooks" prefillRepo="tars" repos={mockRepos} />);
		expect(screen.queryByText("What issue do you want to create?")).not.toBeNull();
		expect(screen.queryByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.")).not.toBeNull();
		expect(screen.queryByText("Issue draft")).not.toBeNull();
	});

	it("renders the Issue Draft preview before the Chat pane", () => {
		const { container } = render(<NewIssueScreen onBack={() => {}} prefillOwner="mbrooks" prefillRepo="tars" repos={mockRepos} />);
		const workspace = container.querySelector(".new-issue-workspace");
		const children = workspace?.children;
		expect(children?.length).toBe(2);
		expect(children?.[0].classList.contains("preview-pane")).toBe(true);
		expect(children?.[1].classList.contains("chat-pane")).toBe(true);
	});

	it("allows toggling privacy mode", () => {
		render(<NewIssueScreen onBack={() => {}} prefillOwner="mbrooks" prefillRepo="tars" repos={mockRepos} />);
		const checkbox = screen.getByLabelText("Privacy mode");
		expect((checkbox as HTMLInputElement).checked).toBe(false);
		fireEvent.click(checkbox);
		expect((checkbox as HTMLInputElement).checked).toBe(true);
	});

	it("continues the conversation and updates the draft preview", async () => {
		render(<NewIssueScreen onBack={() => {}} prefillOwner="mbrooks" prefillRepo="tars" repos={mockRepos} />);

		const input = screen.getByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.");
		fireEvent.change(input, { target: { value: "In mbrooks/tars, something is broken" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByText("I drafted the issue. If this is right, tell me to create it.")).not.toBeNull();
		});

		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith(
				expect.stringContaining("/api/repos/mbrooks/tars/context"),
			);
		});

		await waitFor(() => {
			expect(screen.queryByText("Generated Title")).not.toBeNull();
		});
		expect(screen.queryByText("Generated body")).not.toBeNull();
	});

	it("shows the template selector when templates are available", async () => {
		render(<NewIssueScreen onBack={() => {}} prefillOwner="mbrooks" prefillRepo="tars" repos={mockRepos} />);

		const input = screen.getByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.");
		fireEvent.change(input, { target: { value: "In mbrooks/tars, something is broken" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByText("Template:")).not.toBeNull();
		});
	});

	it("creates the issue through the conversation", async () => {
		render(<NewIssueScreen onBack={() => {}} prefillOwner="mbrooks" prefillRepo="tars" repos={mockRepos} />);

		const input = screen.getByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.");
		fireEvent.change(input, { target: { value: "In mbrooks/tars, something is broken" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByText("Generated Title")).not.toBeNull();
		});

		fireEvent.change(input, { target: { value: "create it" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByText("Issue created:")).not.toBeNull();
		});
	});

	it("renders repo quick-chips when repos are provided", () => {
		render(<NewIssueScreen onBack={() => {}} prefillOwner="mbrooks" prefillRepo="tars" repos={mockRepos} />);
		expect(screen.getByText("mbrooks/tars")).not.toBeNull();
		expect(screen.getByText("other/repo")).not.toBeNull();
	});

	it("selects a repository via quick-chip and fetches context", async () => {
		render(<NewIssueScreen onBack={() => {}} prefillOwner="other" prefillRepo="repo" repos={mockRepos} />);

		const chip = screen.getByText("mbrooks/tars");
		fireEvent.click(chip);

		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith(
				expect.stringContaining("/api/repos/mbrooks/tars/context"),
			);
		});

		const ownerInput = screen.getByLabelText("Repository owner") as HTMLInputElement;
		const repoInput = screen.getByLabelText("Repository name") as HTMLInputElement;
		expect(ownerInput.value).toBe("mbrooks");
		expect(repoInput.value).toBe("tars");
	});

	it("allows manual owner/repo entry", async () => {
		render(<NewIssueScreen onBack={() => {}} prefillOwner="other" prefillRepo="repo" repos={mockRepos} />);

		const ownerInput = screen.getByLabelText("Repository owner") as HTMLInputElement;
		const repoInput = screen.getByLabelText("Repository name") as HTMLInputElement;

		fireEvent.change(ownerInput, { target: { value: "custom" } });
		fireEvent.change(repoInput, { target: { value: "repo" } });

		expect(ownerInput.value).toBe("custom");
		expect(repoInput.value).toBe("repo");
		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith(
				expect.stringContaining("/api/repos/custom/repo/context"),
			);
		});
	});

	it("subscribes to websocket status", () => {
		render(<NewIssueScreen onBack={() => {}} prefillOwner="mbrooks" prefillRepo="tars" repos={mockRepos} />);
		expect(subscribeStatusSpy).toHaveBeenCalledWith(expect.any(Function));
	});

	it("shows websocket connection indicator", () => {
		render(<NewIssueScreen onBack={() => {}} prefillOwner="mbrooks" prefillRepo="tars" repos={mockRepos} />);
		const indicator = screen.queryByTitle(/WebSocket:/i);
		expect(indicator).not.toBeNull();
	});

	it("uses websocket issue chat when the connection is open", async () => {
		connectionStatusSpy.mockReturnValue("open");
		requestIssueChatSpy.mockImplementation(async (_payload, onProgress) => {
			onProgress?.({ type: "started", message: "Thinking through the issue draft..." });
			onProgress?.({ type: "creating", message: "Creating issue in mbrooks/tars..." });
			return {
				message: "Creating the issue now.",
				owner: "mbrooks",
				repo: "tars",
				draft: {
					title: "Generated Title",
					body: "Generated body",
					labels: ["bug"],
					assignees: [],
				},
				readyToCreate: true,
				shouldCreate: true,
				createdIssue: { number: 42, html_url: "http://issue/42" },
			};
		});

		render(<NewIssueScreen onBack={() => {}} prefillOwner="mbrooks" prefillRepo="tars" repos={mockRepos} />);

		const input = screen.getByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.");
		fireEvent.change(input, { target: { value: "create it" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(requestIssueChatSpy).toHaveBeenCalled();
		});
		await waitFor(() => {
			expect(screen.queryByText("Issue created:")).not.toBeNull();
		});
	});

	it("falls back to http issue chat when websocket chat fails before progress starts", async () => {
		connectionStatusSpy.mockReturnValue("open");
		requestIssueChatSpy.mockRejectedValue(new Error("WebSocket disconnected"));

		render(<NewIssueScreen onBack={() => {}} repos={mockRepos} />);

		fireEvent.click(screen.getByText("mbrooks/tars"));

		const input = await screen.findByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.");
		fireEvent.change(input, { target: { value: "create it" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(requestIssueChatSpy).toHaveBeenCalled();
		});
		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith(
				expect.stringContaining("/api/issues/chat"),
				expect.objectContaining({ method: "POST" }),
			);
		});
		await waitFor(() => {
			expect(screen.queryByText("Issue created:")).not.toBeNull();
		});
		expect(screen.queryByText("I couldn't continue the issue draft: WebSocket disconnected")).toBeNull();
	});

	it("shows a Create Issue button when a draft is present", async () => {
		render(<NewIssueScreen onBack={() => {}} prefillOwner="mbrooks" prefillRepo="tars" repos={mockRepos} />);

		const input = screen.getByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.");
		fireEvent.change(input, { target: { value: "In mbrooks/tars, something is broken" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByText("Generated Title")).not.toBeNull();
		});

		expect(screen.queryByRole("button", { name: "Create Issue" })).not.toBeNull();
	});

	it("creates the issue when the Create Issue button is clicked", async () => {
		render(<NewIssueScreen onBack={() => {}} prefillOwner="mbrooks" prefillRepo="tars" repos={mockRepos} />);

		const input = screen.getByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.");
		fireEvent.change(input, { target: { value: "In mbrooks/tars, something is broken" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByText("Generated Title")).not.toBeNull();
		});

		const createBtn = screen.getByRole("button", { name: "Create Issue" });
		fireEvent.click(createBtn);

		await waitFor(() => {
			expect(screen.queryByText("Issue created: [#99](https://github.com/mbrooks/tars/issues/99)")).not.toBeNull();
		});

		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith(
				expect.stringContaining("/api/issues"),
				expect.objectContaining({ method: "POST" }),
			);
		});
	});

	it("disables the Create Issue button while creating", async () => {
		let resolveCreate: (value: unknown) => void = () => {};
		fetchSpy.mockImplementation(async (input: RequestInfo | URL, _init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/repos/")) {
				return mockJsonResponse({
					labels: ["bug", "enhancement"],
					templates: [{ name: "Bug Report", body: "## Steps\n" }],
					recentCommits: ["abc123: fix"],
					relatedIssues: [{ number: 1, title: "Old", state: "closed" }],
				});
			}
			if (url.includes("/api/issues/chat")) {
				return mockJsonResponse({
					message: "I drafted the issue.",
					owner: "mbrooks",
					repo: "tars",
					draft: {
						title: "Generated Title",
						body: "Generated body",
						labels: ["bug"],
						assignees: [],
					},
					readyToCreate: true,
					shouldCreate: false,
				});
			}
			if (url.includes("/api/issues") && !url.includes("/chat") && !url.includes("/generate")) {
				return new Promise((resolve) => {
					resolveCreate = resolve;
				});
			}
			return mockJsonResponse({});
		});

		render(<NewIssueScreen onBack={() => {}} prefillOwner="mbrooks" prefillRepo="tars" repos={mockRepos} />);

		const input = screen.getByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.");
		fireEvent.change(input, { target: { value: "something is broken" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByText("Generated Title")).not.toBeNull();
		});

		const createBtn = screen.getByRole("button", { name: "Create Issue" });
		fireEvent.click(createBtn);

		await waitFor(() => {
			expect(screen.queryByRole("button", { name: "Creating..." })).not.toBeNull();
		});

		resolveCreate(mockJsonResponse({ number: 99, html_url: "https://github.com/mbrooks/tars/issues/99" }));

		await waitFor(() => {
			expect(screen.queryByRole("button", { name: "Creating..." })).toBeNull();
		});
	});

	it("handles an error when the Create Issue button fails", async () => {
		fetchSpy.mockImplementation(async (input: RequestInfo | URL, _init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/repos/")) {
				return mockJsonResponse({
					labels: ["bug", "enhancement"],
					templates: [{ name: "Bug Report", body: "## Steps\n" }],
					recentCommits: ["abc123: fix"],
					relatedIssues: [{ number: 1, title: "Old", state: "closed" }],
				});
			}
			if (url.includes("/api/issues/chat")) {
				return mockJsonResponse({
					message: "I drafted the issue.",
					owner: "mbrooks",
					repo: "tars",
					draft: {
						title: "Generated Title",
						body: "Generated body",
						labels: ["bug"],
						assignees: [],
					},
					readyToCreate: true,
					shouldCreate: false,
				});
			}
			if (url.includes("/api/issues") && !url.includes("/chat") && !url.includes("/generate")) {
				return new Response(JSON.stringify({ error: "GitHub error" }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
			return mockJsonResponse({});
		});

		render(<NewIssueScreen onBack={() => {}} prefillOwner="mbrooks" prefillRepo="tars" repos={mockRepos} />);

		const input = screen.getByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.");
		fireEvent.change(input, { target: { value: "something is broken" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByText("Generated Title")).not.toBeNull();
		});

		const createBtn = screen.getByRole("button", { name: "Create Issue" });
		fireEvent.click(createBtn);

		await waitFor(() => {
			expect(screen.queryByText(/I couldn't create the issue:/)).not.toBeNull();
		});
	});

	it("hides the Create Issue button after an issue is created via the button", async () => {
		render(<NewIssueScreen onBack={() => {}} prefillOwner="mbrooks" prefillRepo="tars" repos={mockRepos} />);

		const input = screen.getByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.");
		fireEvent.change(input, { target: { value: "In mbrooks/tars, something is broken" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByText("Generated Title")).not.toBeNull();
		});

		expect(screen.queryByRole("button", { name: "Create Issue" })).not.toBeNull();

		const createBtn = screen.getByRole("button", { name: "Create Issue" });
		fireEvent.click(createBtn);

		await waitFor(() => {
			expect(screen.queryByText("Issue created: [#99](https://github.com/mbrooks/tars/issues/99)")).not.toBeNull();
		});

		expect(screen.queryByRole("button", { name: "Create Issue" })).toBeNull();
	});
});
