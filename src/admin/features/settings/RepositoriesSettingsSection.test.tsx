// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

import { RepositoriesSettingsSection } from "./RepositoriesSettingsSection.js";

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function accessibleResponse(
	repositories: Array<{ owner: string; repo: string; fullName: string; visibility: "public" | "private" | "internal" }>,
	configured: Array<{ owner: string; repo: string }>,
): Response {
	return jsonResponse({ repositories, configured });
}

function mockAccessible(
	repositories: Array<{ owner: string; repo: string; fullName: string; visibility: "public" | "private" | "internal" }>,
	configured: Array<{ owner: string; repo: string }>,
	patchResponse: { updated: string[]; requiresRestart: string[] } = { updated: [], requiresRestart: [] },
) {
	return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
		const url = typeof input === "string" ? input : input.url;
		if (url === "/api/repos/accessible" && init?.method !== "PATCH") {
			return Promise.resolve(accessibleResponse(repositories, configured));
		}
		if (url === "/api/settings" && init?.method === "PATCH") {
			return Promise.resolve(jsonResponse(patchResponse));
		}
		return Promise.reject(new Error(`Unexpected fetch: ${url}`));
	});
}

describe("RepositoriesSettingsSection", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shows a loading state before repositories are fetched", () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		render(<RepositoriesSettingsSection />);
		expect(screen.getByText("Loading repositories...")).not.toBeNull();
	});

	it("renders accessible repositories with configured repos preselected", async () => {
		mockAccessible(
			[
				{ owner: "mbrooks", repo: "tars", fullName: "mbrooks/tars", visibility: "private" },
				{ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", visibility: "public" },
			],
			[{ owner: "mbrooks", repo: "tars" }],
		);
		render(<RepositoriesSettingsSection />);

		const tarsCheckbox = await screen.findByRole("checkbox", { name: /mbrooks\/tars/ }) as HTMLInputElement;
		const helloCheckbox = screen.getByRole("checkbox", { name: /octocat\/hello-world/ }) as HTMLInputElement;
		expect(tarsCheckbox.checked).toBe(true);
		expect(helloCheckbox.checked).toBe(false);
		expect(screen.getByText("1 of 2 selected")).not.toBeNull();
	});

	it("retains configured repos that are no longer accessible so they can be deselected", async () => {
		mockAccessible(
			[
				{ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", visibility: "public" },
			],
			[
				{ owner: "octocat", repo: "hello-world" },
				{ owner: "ghost", repo: "removed" },
			],
		);
		render(<RepositoriesSettingsSection />);

		await waitFor(() => {
			expect(screen.getByRole("checkbox", { name: /ghost\/removed/ })).not.toBeNull();
		});
		const ghostCheckbox = screen.getByRole("checkbox", { name: /ghost\/removed/ }) as HTMLInputElement;
		expect(ghostCheckbox.checked).toBe(true);
	});

	it("toggles individual repo selection and enables save", async () => {
		const fetchSpy = mockAccessible(
			[
				{ owner: "mbrooks", repo: "tars", fullName: "mbrooks/tars", visibility: "private" },
				{ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", visibility: "public" },
			],
			[{ owner: "mbrooks", repo: "tars" }],
		);
		render(<RepositoriesSettingsSection />);

		const helloCheckbox = await screen.findByRole("checkbox", { name: /octocat\/hello-world/ }) as HTMLInputElement;
		expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(true);

		fireEvent.click(helloCheckbox);
		expect(helloCheckbox.checked).toBe(true);
		expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(false);
		expect(screen.getByText("2 of 2 selected")).not.toBeNull();
		// No PATCH issued yet.
		expect(fetchSpy.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
	});

	it("Select All and Deselect All toggle the full displayed list", async () => {
		mockAccessible(
			[
				{ owner: "mbrooks", repo: "tars", fullName: "mbrooks/tars", visibility: "private" },
				{ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", visibility: "public" },
			],
			[{ owner: "mbrooks", repo: "tars" }],
		);
		render(<RepositoriesSettingsSection />);

		await screen.findByRole("checkbox", { name: /mbrooks\/tars/ });

		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		expect(screen.getByText("2 of 2 selected")).not.toBeNull();
		expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(false);

		fireEvent.click(screen.getByRole("button", { name: "Deselect All" }));
		expect(screen.getByText("0 of 2 selected")).not.toBeNull();
		expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(false);
	});

	it("persists selections to configured_repositories via PATCH /api/settings", async () => {
		const fetchSpy = mockAccessible(
			[
				{ owner: "mbrooks", repo: "tars", fullName: "mbrooks/tars", visibility: "private" },
				{ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", visibility: "public" },
			],
			[{ owner: "mbrooks", repo: "tars" }],
		);
		render(<RepositoriesSettingsSection />);

		await screen.findByRole("checkbox", { name: /octocat\/hello-world/ });
		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

		await waitFor(() => {
			expect(screen.getByText("Repositories saved.")).not.toBeNull();
		});

		const patchCall = fetchSpy.mock.calls.find(([, init]) => init?.method === "PATCH");
		expect(patchCall).toBeDefined();
		const body = JSON.parse(patchCall![1]!.body as string);
		expect(body).toEqual({
			configured_repositories: JSON.stringify([
				{ owner: "mbrooks", repo: "tars" },
				{ owner: "octocat", repo: "hello-world" },
			]),
		});
		// Save disabled again after persisting.
		expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("shows an empty state when no repositories are accessible", async () => {
		mockAccessible([], []);
		render(<RepositoriesSettingsSection />);

		await waitFor(() => {
			expect(
				screen.getByText("No repositories are available to the configured GitHub account."),
			).not.toBeNull();
		});
	});

	it("shows an error banner when the accessible fetch fails", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
			const url = typeof input === "string" ? input : input.url;
			if (url === "/api/repos/accessible") {
				return Promise.resolve(jsonResponse({ error: "GitHub service not configured" }, 500));
			}
			return Promise.reject(new Error(`Unexpected fetch: ${url}`));
		});
		render(<RepositoriesSettingsSection />);

		await waitFor(() => {
			expect(screen.getByText("HTTP 500")).not.toBeNull();
		});
	});

	it("shows an error banner when the save PATCH fails", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
			const url = typeof input === "string" ? input : input.url;
			if (url === "/api/repos/accessible" && init?.method !== "PATCH") {
				return Promise.resolve(accessibleResponse(
					[{ owner: "mbrooks", repo: "tars", fullName: "mbrooks/tars", visibility: "private" }],
					[],
				));
			}
			if (url === "/api/settings" && init?.method === "PATCH") {
				return Promise.resolve(jsonResponse({ error: "Database locked" }, 500));
			}
			return Promise.reject(new Error(`Unexpected fetch: ${url}`));
		});
		render(<RepositoriesSettingsSection />);

		await screen.findByRole("checkbox", { name: /mbrooks\/tars/ });
		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

		await waitFor(() => {
			expect(screen.getByText("Database locked")).not.toBeNull();
		});
	});
});