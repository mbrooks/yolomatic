// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

import { NewIssueScreen } from "./NewIssueScreen.js";

function mockJsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("NewIssueScreen", () => {
	let fetchSpy: any;

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

				if (lastUserMessage === "mbrooks/tars") {
					return mockJsonResponse({
						message: "Working in mbrooks/tars. Describe the issue you want to create.",
						owner: "mbrooks",
						repo: "tars",
						draft: { title: "", body: "", labels: [], assignees: [] },
						readyToCreate: false,
						shouldCreate: false,
					});
				}

				if (lastUserMessage === "something is broken") {
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
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("renders the conversational interface by default", () => {
		render(<NewIssueScreen onBack={() => {}} />);
		expect(screen.queryByText("Which repository should I create the issue in?")).not.toBeNull();
		expect(screen.queryByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.")).not.toBeNull();
		expect(screen.queryByText("Issue draft")).not.toBeNull();
	});

	it("allows toggling privacy mode", () => {
		render(<NewIssueScreen onBack={() => {}} />);
		const checkbox = screen.getByLabelText("Privacy mode");
		expect((checkbox as HTMLInputElement).checked).toBe(false);
		fireEvent.click(checkbox);
		expect((checkbox as HTMLInputElement).checked).toBe(true);
	});

	it("continues the conversation and updates the draft preview", async () => {
		render(<NewIssueScreen onBack={() => {}} />);

		const input = screen.getByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.");
		fireEvent.change(input, { target: { value: "mbrooks/tars" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByText("Working in mbrooks/tars. Describe the issue you want to create.")).not.toBeNull();
		});

		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith(
				expect.stringContaining("/api/repos/mbrooks/tars/context"),
			);
		});

		fireEvent.change(input, { target: { value: "something is broken" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByText("Generated Title")).not.toBeNull();
		});
		expect(screen.queryByText("Generated body")).not.toBeNull();
	});

	it("shows the template selector when templates are available", async () => {
		render(<NewIssueScreen onBack={() => {}} />);

		const input = screen.getByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.");
		fireEvent.change(input, { target: { value: "mbrooks/tars" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByText("Template:")).not.toBeNull();
		});
	});

	it("creates the issue through the conversation", async () => {
		render(<NewIssueScreen onBack={() => {}} />);

		const input = screen.getByPlaceholderText("Tell TARS what issue to create. Use Shift+Enter for a newline.");
		fireEvent.change(input, { target: { value: "mbrooks/tars" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByText("Working in mbrooks/tars. Describe the issue you want to create.")).not.toBeNull();
		});

		fireEvent.change(input, { target: { value: "something is broken" } });
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
});
