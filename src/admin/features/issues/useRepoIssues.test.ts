// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useRepoIssues } from "./useRepoIssues.js";

vi.mock("../../api/issues.js", () => ({
	fetchOpenIssues: vi.fn(),
}));

import { fetchOpenIssues } from "../../api/issues.js";

describe("useRepoIssues", () => {
	it("loads issues on mount", async () => {
		vi.mocked(fetchOpenIssues).mockResolvedValue([
			{ number: 1, title: "Bug", body: "desc", state: "open", labels: ["bug"], assignees: [], html_url: "" },
		]);
		const { result } = renderHook(() => useRepoIssues("mbrooks", "tars"));
		expect(result.current.loading).toBe(true);
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.issues).toHaveLength(1);
		expect(result.current.issues[0].title).toBe("Bug");
	});

	it("sets loading to false and issues empty on error", async () => {
		vi.mocked(fetchOpenIssues).mockRejectedValue(new Error("Network error"));
		const { result } = renderHook(() => useRepoIssues("mbrooks", "tars"));
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.issues).toEqual([]);
	});

	it("reloads issues when reload is called", async () => {
		vi.mocked(fetchOpenIssues).mockResolvedValue([
			{ number: 1, title: "Bug", body: "desc", state: "open", labels: [], assignees: [], html_url: "" },
		]);
		const { result } = renderHook(() => useRepoIssues("mbrooks", "tars"));
		await waitFor(() => expect(result.current.loading).toBe(false));

		vi.mocked(fetchOpenIssues).mockResolvedValue([
			{ number: 2, title: "Feature", body: "desc", state: "open", labels: [], assignees: [], html_url: "" },
		]);
		await act(async () => {
			result.current.reload();
		});
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.issues).toHaveLength(1);
		expect(result.current.issues[0].title).toBe("Feature");
	});
});
