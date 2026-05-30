// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useInvitations } from "./useInvitations.js";

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("useInvitations", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reloads invitations on demand", async () => {
		let callCount = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			callCount++;
			return jsonResponse({ invitations: [] });
		});

		const { result } = renderHook(() => useInvitations());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(callCount).toBe(1);

		act(() => {
			result.current.reload();
		});

		await waitFor(() => {
			expect(callCount).toBe(2);
		});
	});

	it("loads invitations on mount", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				invitations: [
					{
						id: 1,
						repository: { full_name: "octocat/Hello-World", name: "Hello-World", owner: { login: "octocat" } },
						inviter: { login: "octocat" },
						permissions: "write",
						created_at: "2024-01-01T00:00:00Z",
						html_url: "https://github.com/octocat/Hello-World/invitations",
					},
				],
			}),
		);

		const { result } = renderHook(() => useInvitations());

		expect(result.current.loading).toBe(true);
		expect(result.current.invitations).toEqual([]);

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(result.current.invitations).toHaveLength(1);
		expect(result.current.invitations[0].id).toBe(1);
		expect(fetchSpy).toHaveBeenCalledWith("/api/github/invitations");
	});

	it("handles fetch errors gracefully", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

		const { result } = renderHook(() => useInvitations());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(result.current.invitations).toEqual([]);
	});

	it("accepts an invitation and removes it from list", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "/api/github/invitations") {
				return jsonResponse({
					invitations: [
						{
							id: 1,
							repository: { full_name: "octocat/Hello-World", name: "Hello-World", owner: { login: "octocat" } },
							inviter: { login: "octocat" },
							permissions: "write",
							created_at: "2024-01-01T00:00:00Z",
							html_url: "https://github.com/octocat/Hello-World/invitations",
						},
					],
				});
			}
			if (url === "/api/github/invitations/1/accept") {
				return jsonResponse({ accepted: true });
			}
			return jsonResponse({});
		});

		const { result } = renderHook(() => useInvitations());

		await waitFor(() => {
			expect(result.current.invitations).toHaveLength(1);
		});

		await result.current.accept(1);

		await waitFor(() => {
			expect(result.current.invitations).toHaveLength(0);
		});
		expect(result.current.accepting).toBeNull();
		expect(fetchSpy).toHaveBeenCalledWith("/api/github/invitations/1/accept", {
			method: "POST",
		});
	});

	it("handles accept errors gracefully", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "/api/github/invitations") {
				return jsonResponse({
					invitations: [
						{
							id: 1,
							repository: { full_name: "octocat/Hello-World", name: "Hello-World", owner: { login: "octocat" } },
							inviter: { login: "octocat" },
							permissions: "write",
							created_at: "2024-01-01T00:00:00Z",
							html_url: "https://github.com/octocat/Hello-World/invitations",
						},
					],
				});
			}
			if (url === "/api/github/invitations/1/accept") {
				return jsonResponse({ error: "Not found" }, 500);
			}
			return jsonResponse({});
		});

		const { result } = renderHook(() => useInvitations());

		await waitFor(() => {
			expect(result.current.invitations).toHaveLength(1);
		});

		await expect(result.current.accept(1)).rejects.toThrow("Not found");

		await waitFor(() => {
			expect(result.current.accepting).toBeNull();
		});
		expect(result.current.invitations).toHaveLength(1);
	});
});
