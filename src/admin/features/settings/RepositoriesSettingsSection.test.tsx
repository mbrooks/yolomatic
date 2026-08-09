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
	addResponse: { owner: string; repo: string; fullName: string; added: boolean } = { owner: "", repo: "", fullName: "", added: true },
	removeResponse: { removed: boolean } = { removed: true },
) {
	return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
		const url = typeof input === "string" ? input : input.url;
		const method = init?.method;
		if (url === "/api/repos/accessible" && (!method || method === "GET")) {
			return Promise.resolve(accessibleResponse(repositories, configured));
		}
		if (url === "/api/repos" && method === "POST") {
			return Promise.resolve(jsonResponse(addResponse));
		}
		if (url.startsWith("/api/repos/") && method === "DELETE") {
			return Promise.resolve(jsonResponse(removeResponse));
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
				{ owner: "mbrooks", repo: "yolomatic", fullName: "mbrooks/yolomatic", visibility: "private" },
				{ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", visibility: "public" },
			],
			[{ owner: "mbrooks", repo: "yolomatic" }],
		);
		render(<RepositoriesSettingsSection />);

		const yolomaticCheckbox = await screen.findByRole("checkbox", { name: /mbrooks\/yolomatic/ }) as HTMLInputElement;
		const helloCheckbox = screen.getByRole("checkbox", { name: /octocat\/hello-world/ }) as HTMLInputElement;
		expect(yolomaticCheckbox.checked).toBe(true);
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
				{ owner: "mbrooks", repo: "yolomatic", fullName: "mbrooks/yolomatic", visibility: "private" },
				{ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", visibility: "public" },
			],
			[{ owner: "mbrooks", repo: "yolomatic" }],
		);
		render(<RepositoriesSettingsSection />);

		const helloCheckbox = await screen.findByRole("checkbox", { name: /octocat\/hello-world/ }) as HTMLInputElement;
		expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(true);

		fireEvent.click(helloCheckbox);
		expect(helloCheckbox.checked).toBe(true);
		expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(false);
		expect(screen.getByText("2 of 2 selected")).not.toBeNull();
		// No mutation issued yet.
		expect(fetchSpy.mock.calls.some(([, init]) => init?.method === "POST" || init?.method === "DELETE")).toBe(false);
	});

	it("Select All and Deselect All toggle the full displayed list", async () => {
		mockAccessible(
			[
				{ owner: "mbrooks", repo: "yolomatic", fullName: "mbrooks/yolomatic", visibility: "private" },
				{ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", visibility: "public" },
			],
			[{ owner: "mbrooks", repo: "yolomatic" }],
		);
		render(<RepositoriesSettingsSection />);

		await screen.findByRole("checkbox", { name: /mbrooks\/yolomatic/ });

		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		expect(screen.getByText("2 of 2 selected")).not.toBeNull();
		expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(false);

		fireEvent.click(screen.getByRole("button", { name: "Deselect All" }));
		expect(screen.getByText("0 of 2 selected")).not.toBeNull();
		expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(false);
	});

	it("adds new selections via POST /api/repos and removes deselections via DELETE /api/repos/:owner/:repo", async () => {
		const fetchSpy = mockAccessible(
			[
				{ owner: "mbrooks", repo: "yolomatic", fullName: "mbrooks/yolomatic", visibility: "private" },
				{ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", visibility: "public" },
			],
			[{ owner: "mbrooks", repo: "yolomatic" }],
		);
		render(<RepositoriesSettingsSection />);

		await screen.findByRole("checkbox", { name: /octocat\/hello-world/ });
		// Deselect the configured repo (mbrooks/yolomatic) and select the new one (octocat/hello-world).
		fireEvent.click(screen.getByRole("checkbox", { name: /mbrooks\/yolomatic/ }));
		fireEvent.click(screen.getByRole("checkbox", { name: /octocat\/hello-world/ }));
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

		await waitFor(() => {
			expect(screen.getByText("Repositories saved.")).not.toBeNull();
		});

		const postCall = fetchSpy.mock.calls.find(([input, init]) => {
			const url = typeof input === "string" ? input : input.url;
			return url === "/api/repos" && init?.method === "POST";
		});
		expect(postCall).toBeDefined();
		expect(JSON.parse(postCall![1]!.body as string)).toEqual({ owner: "octocat", repo: "hello-world" });

		const deleteCall = fetchSpy.mock.calls.find(([input, init]) => {
			const url = typeof input === "string" ? input : input.url;
			return url === "/api/repos/mbrooks/yolomatic" && init?.method === "DELETE";
		});
		expect(deleteCall).toBeDefined();
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

	it("shows an error banner when an add fails during save", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
			const url = typeof input === "string" ? input : input.url;
			const method = init?.method;
			if (url === "/api/repos/accessible" && (!method || method === "GET")) {
				return Promise.resolve(accessibleResponse(
					[{ owner: "mbrooks", repo: "yolomatic", fullName: "mbrooks/yolomatic", visibility: "private" }],
					[],
				));
			}
			if (url === "/api/repos" && method === "POST") {
				return Promise.resolve(jsonResponse({ error: "Database locked" }, 500));
			}
			return Promise.reject(new Error(`Unexpected fetch: ${url}`));
		});
		render(<RepositoriesSettingsSection />);

		await screen.findByRole("checkbox", { name: /mbrooks\/yolomatic/ });
		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

		await waitFor(() => {
			expect(screen.getByText(/Database locked/)).not.toBeNull();
		});
	});

	it("opens a manual Add Repository modal and adds the repo, then refreshes the list", async () => {
		let accessibleCallCount = 0;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
			const url = typeof input === "string" ? input : input.url;
			const method = init?.method;
			if (url === "/api/repos/accessible" && (!method || method === "GET")) {
				accessibleCallCount++;
				return Promise.resolve(accessibleResponse(
					[{ owner: "mbrooks", repo: "yolomatic", fullName: "mbrooks/yolomatic", visibility: "private" }],
					[],
				));
			}
			if (url === "/api/repos" && method === "POST") {
				return Promise.resolve(jsonResponse({ owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world", added: true }));
			}
			return Promise.reject(new Error(`Unexpected fetch: ${url}`));
		});
		render(<RepositoriesSettingsSection />);

		await screen.findByRole("checkbox", { name: /mbrooks\/yolomatic/ });
		expect(accessibleCallCount).toBe(1);

		fireEvent.click(screen.getByRole("button", { name: /add repository/i }));
		expect(screen.getByRole("dialog")).not.toBeNull();
		fireEvent.change(screen.getByLabelText(/^owner$/i), { target: { value: "octocat" } });
		fireEvent.change(screen.getByLabelText(/^repository name$/i), { target: { value: "hello-world" } });
		fireEvent.click(screen.getByRole("button", { name: /^add repository$/i }));

		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});
		const postCall = fetchSpy.mock.calls.find(([input, init]) => {
			const url = typeof input === "string" ? input : input.url;
			return url === "/api/repos" && init?.method === "POST";
		});
		expect(postCall).toBeDefined();
		expect(JSON.parse(postCall![1]!.body as string)).toEqual({ owner: "octocat", repo: "hello-world" });
		// Manual add triggers a refresh of the accessible list.
		await waitFor(() => {
			expect(accessibleCallCount).toBe(2);
		});
	});

	it("shows a validation error in the Add Repository modal when fields are blank", async () => {
		mockAccessible(
			[{ owner: "mbrooks", repo: "yolomatic", fullName: "mbrooks/yolomatic", visibility: "private" }],
			[],
		);
		render(<RepositoriesSettingsSection />);

		await screen.findByRole("checkbox", { name: /mbrooks\/yolomatic/ });
		fireEvent.click(screen.getByRole("button", { name: /add repository/i }));
		fireEvent.click(screen.getByRole("button", { name: /^add repository$/i }));

		await waitFor(() => {
			expect(screen.getByText(/owner and repository name are required/i)).not.toBeNull();
		});
		expect(screen.getByRole("dialog")).not.toBeNull();
	});

	it("refreshes the accessible list when Refresh is clicked", async () => {
		let accessibleCallCount = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
			const url = typeof input === "string" ? input : input.url;
			const method = init?.method;
			if (url === "/api/repos/accessible" && (!method || method === "GET")) {
				accessibleCallCount++;
				return Promise.resolve(accessibleResponse(
					[{ owner: "mbrooks", repo: "yolomatic", fullName: "mbrooks/yolomatic", visibility: "private" }],
					[],
				));
			}
			return Promise.reject(new Error(`Unexpected fetch: ${url}`));
		});
		render(<RepositoriesSettingsSection />);

		await screen.findByRole("checkbox", { name: /mbrooks\/yolomatic/ });
		expect(accessibleCallCount).toBe(1);

		fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
		await waitFor(() => {
			expect(accessibleCallCount).toBe(2);
		});
	});
});