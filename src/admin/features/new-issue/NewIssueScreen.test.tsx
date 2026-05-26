// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

import { NewIssueScreen } from "./NewIssueScreen.js";

function mockOkResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function mockPostResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("NewIssueScreen", () => {
	let fetchSpy: any;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/repos/")) {
				return mockOkResponse({
					labels: ["bug", "enhancement"],
					templates: [{ name: "Bug Report", body: "## Steps\n" }],
					recentCommits: ["abc123: fix"],
					relatedIssues: [{ number: 1, title: "Old", state: "closed" }],
				});
			}
			if (url.includes("/api/issues/generate")) {
				return mockPostResponse({
					title: "Generated Title",
					body: "Generated body",
					labels: ["bug"],
					assignees: [],
				});
			}
			if (url.includes("/api/issues")) {
				return mockPostResponse({ number: 42, html_url: "http://issue/42" });
			}
			return mockOkResponse({});
		});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("renders chat interface by default", () => {
		render(<NewIssueScreen onBack={() => {}} />);
		expect(screen.queryByText("Which repository should I create the issue in?")).not.toBeNull();
		expect(screen.queryByPlaceholderText("owner/repo")).not.toBeNull();
	});

	it("switches to classic form and back", async () => {
		render(<NewIssueScreen onBack={() => {}} />);

		const classicBtn = screen.getByText("Classic form");
		expect(classicBtn).not.toBeNull();

		fireEvent.click(classicBtn);
		await waitFor(() => {
			expect(screen.queryByText("Title *")).not.toBeNull();
		});

		const backBtn = screen.getByText("Back");
		fireEvent.click(backBtn);
		await waitFor(() => {
			expect(screen.queryByPlaceholderText("owner/repo")).not.toBeNull();
		});
	});

	it("allows toggling privacy mode", () => {
		render(<NewIssueScreen onBack={() => {}} />);
		const checkbox = screen.getByLabelText("Privacy mode");
		expect((checkbox as HTMLInputElement).checked).toBe(false);
		fireEvent.click(checkbox);
		expect((checkbox as HTMLInputElement).checked).toBe(true);
	});

	it("generates an issue via conversation", async () => {
		render(<NewIssueScreen onBack={() => {}} />);

		const input = screen.getByPlaceholderText("owner/repo");
		fireEvent.change(input, { target: { value: "mbrooks/tars" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByPlaceholderText("Describe the issue...")).not.toBeNull();
		});

		const promptInput = screen.getByPlaceholderText("Describe the issue...");
		fireEvent.change(promptInput, { target: { value: "something is broken" } });
		fireEvent.keyDown(promptInput, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByText("Here's a draft:")).not.toBeNull();
		});

		await waitFor(() => {
			expect(screen.queryAllByText("Generated Title").length).toBeGreaterThan(0);
		});
	});

	it("loads repo context after repo is entered", async () => {
		render(<NewIssueScreen onBack={() => {}} />);

		const input = screen.getByPlaceholderText("owner/repo");
		fireEvent.change(input, { target: { value: "mbrooks/tars" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith(
				expect.stringContaining("/api/repos/mbrooks/tars/context"),
			);
		});
	});

	it("shows template selector when templates are available", async () => {
		render(<NewIssueScreen onBack={() => {}} />);

		const input = screen.getByPlaceholderText("owner/repo");
		fireEvent.change(input, { target: { value: "mbrooks/tars" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByText("Template:")).not.toBeNull();
		});
	});

	it("allows selecting a template", async () => {
		render(<NewIssueScreen onBack={() => {}} />);

		const input = screen.getByPlaceholderText("owner/repo");
		fireEvent.change(input, { target: { value: "mbrooks/tars" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByText("Template:")).not.toBeNull();
		});

		const select = screen.getByDisplayValue("None (auto-detect)");
		fireEvent.change(select, { target: { value: "Bug Report" } });
		expect((select as HTMLSelectElement).value).toBe("Bug Report");
	});

	it("creates issue from review state", async () => {
		render(<NewIssueScreen onBack={() => {}} />);

		const input = screen.getByPlaceholderText("owner/repo");
		fireEvent.change(input, { target: { value: "mbrooks/tars" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByPlaceholderText("Describe the issue...")).not.toBeNull();
		});

		const promptInput = screen.getByPlaceholderText("Describe the issue...");
		fireEvent.change(promptInput, { target: { value: "broken" } });
		fireEvent.keyDown(promptInput, { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByText("Looks good - create it")).not.toBeNull();
		});

		fireEvent.click(screen.getByText("Looks good - create it"));

		await waitFor(() => {
			expect(screen.queryByText("Issue created:")).not.toBeNull();
		});
	});

});
