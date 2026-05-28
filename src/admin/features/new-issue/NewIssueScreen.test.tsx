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
});
