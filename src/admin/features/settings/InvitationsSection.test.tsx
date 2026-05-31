// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

import { InvitationsSection } from "./InvitationsSection.js";

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("InvitationsSection", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders loading state initially", () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		render(<InvitationsSection />);
		expect(screen.getByText("Loading invitations...")).not.toBeNull();
	});

	it("renders empty state when no invitations", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ invitations: [] }));
		render(<InvitationsSection />);

		await waitFor(() => {
			expect(screen.getByText("No pending invitations.")).not.toBeNull();
		});
	});

	it("renders invitation rows with accept buttons", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
		render(<InvitationsSection />);

		await waitFor(() => {
			expect(screen.getByText("octocat/Hello-World")).not.toBeNull();
		});

		expect(screen.getByText(/Invited by octocat/)).not.toBeNull();
		expect(screen.getByRole("button", { name: "Accept" })).not.toBeNull();
	});

	it("calls accept when button is clicked", async () => {
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

		render(<InvitationsSection />);

		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Accept" })).not.toBeNull();
		});

		fireEvent.click(screen.getByRole("button", { name: "Accept" }));

		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith("/api/github/invitations/1/accept", {
				method: "POST",
			});
		});

		await waitFor(() => {
			expect(screen.getByText("No pending invitations.")).not.toBeNull();
		});
	});

	it("refreshes invitations when refresh button is clicked", async () => {
		let callCount = 0;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "/api/github/invitations") {
				callCount++;
				return jsonResponse({ invitations: [] });
			}
			return jsonResponse({});
		});

		render(<InvitationsSection />);

		await waitFor(() => {
			expect(screen.getByText("No pending invitations.")).not.toBeNull();
		});

		expect(callCount).toBe(1);

		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

		await waitFor(() => {
			expect(callCount).toBe(2);
		});
	});
});
