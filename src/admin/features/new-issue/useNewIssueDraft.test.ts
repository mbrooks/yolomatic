// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasDraftContent, useNewIssueDraft } from "./useNewIssueDraft.js";

function mockJsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("hasDraftContent", () => {
	it("detects meaningful draft fields", () => {
		expect(hasDraftContent({ title: "  ", body: "", labels: [], assignees: [] })).toBe(false);
		expect(hasDraftContent({ title: "Bug", body: "", labels: [], assignees: [] })).toBe(true);
		expect(hasDraftContent({ title: "", body: "", labels: ["bug"], assignees: [] })).toBe(true);
	});
});

describe("useNewIssueDraft", () => {
	let fetchSpy: any;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("creates the current issue draft and announces the created issue", async () => {
		const onAssistantMessage = vi.fn();
		fetchSpy.mockResolvedValue(mockJsonResponse({ number: 306, html_url: "https://github.com/mbrooks/tars/issues/306" }));
		const { result } = renderHook(() =>
			useNewIssueDraft({
				initialOwner: "mbrooks",
				initialRepo: "tars",
				onAssistantMessage,
			}),
		);

		act(() => {
			result.current.setDraft({
				title: "Reduce state concentration",
				body: "Move state into hooks.",
				labels: ["admin"],
				assignees: ["mbrooks"],
			});
		});
		let error: string | null = "unset";
		await act(async () => {
			error = await result.current.createCurrentIssue();
		});

		expect(error).toBeNull();
		expect(fetchSpy).toHaveBeenCalledWith("/api/issues", {
			body: JSON.stringify({
				owner: "mbrooks",
				repo: "tars",
				title: "Reduce state concentration",
				body: "Move state into hooks.",
				labels: ["admin"],
				assignees: ["mbrooks"],
			}),
			headers: { "Content-Type": "application/json" },
			method: "POST",
		});
		expect(result.current.createdIssue).toEqual({ number: 306, html_url: "https://github.com/mbrooks/tars/issues/306" });
		expect(onAssistantMessage).toHaveBeenCalledWith("Issue created: [#306](https://github.com/mbrooks/tars/issues/306)");
	});

	it("returns and announces create failures", async () => {
		const onAssistantMessage = vi.fn();
		fetchSpy.mockResolvedValue(mockJsonResponse({ error: "GitHub rejected it" }, 422));
		const { result } = renderHook(() =>
			useNewIssueDraft({
				initialOwner: "mbrooks",
				initialRepo: "tars",
				onAssistantMessage,
			}),
		);

		act(() => {
			result.current.setDraft({ title: "Bug", body: "", labels: [], assignees: [] });
		});
		let error: string | null = null;
		await act(async () => {
			error = await result.current.createCurrentIssue();
		});

		expect(error).toBe("GitHub rejected it");
		expect(result.current.createdIssue).toBeNull();
		expect(onAssistantMessage).toHaveBeenCalledWith("I couldn't create the issue: GitHub rejected it");
	});

	it("resets draft state without creating an issue", async () => {
		const onAssistantMessage = vi.fn();
		const { result } = renderHook(() =>
			useNewIssueDraft({
				initialOwner: "mbrooks",
				initialRepo: "tars",
				onAssistantMessage,
			}),
		);

		act(() => {
			result.current.setDraft({ title: "Bug", body: "Body", labels: ["bug"], assignees: ["user"] });
			result.current.setCreatedIssue({ number: 1, html_url: "https://example.com" });
			result.current.resetDraft();
		});

		expect(result.current.draft).toEqual({ title: "", body: "", labels: [], assignees: [] });
		expect(result.current.createdIssue).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
