import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPendingInvitations, acceptInvitation } from "./github.js";

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("github api", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fetches pending invitations via GET", async () => {
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

		await expect(fetchPendingInvitations()).resolves.toEqual([
			{
				id: 1,
				repository: { full_name: "octocat/Hello-World", name: "Hello-World", owner: { login: "octocat" } },
				inviter: { login: "octocat" },
				permissions: "write",
				created_at: "2024-01-01T00:00:00Z",
				html_url: "https://github.com/octocat/Hello-World/invitations",
			},
		]);

		expect(fetchSpy).toHaveBeenCalledWith("/api/github/invitations");
	});

	it("returns empty array when response lacks invitations field", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}));
		await expect(fetchPendingInvitations()).resolves.toEqual([]);
	});

	it("throws on fetch error for pending invitations", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "Server Error" }, 500));
		await expect(fetchPendingInvitations()).rejects.toThrow("HTTP 500");
	});

	it("accepts an invitation via POST", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ accepted: true }),
		);

		await expect(acceptInvitation(1)).resolves.toEqual({ accepted: true });

		expect(fetchSpy).toHaveBeenCalledWith("/api/github/invitations/1/accept", {
			method: "POST",
		});
	});

	it("throws on fetch error when accepting invitation", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "Not found" }, 404));
		await expect(acceptInvitation(1)).rejects.toThrow("Not found");
	});
});
