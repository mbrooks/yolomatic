// @vitest-environment happy-dom
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RepoSettingsScreen } from "./RepoSettingsScreen.js";

const fetchSpy = vi.fn();

vi.stubGlobal("fetch", fetchSpy);

function jsonResponse(body: unknown) {
	return Promise.resolve({
		ok: true,
		json: async () => body,
	});
}

describe("RepoSettingsScreen", () => {
	beforeEach(() => {
		fetchSpy.mockReset();
		fetchSpy.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "/api/repos/mbrooks/tars/settings" && (!init || init.method === undefined)) {
				return jsonResponse({
					settings: [
						{
							key: "github_event_mode",
							value: "polling",
							default: "webhook",
							override: "polling",
							inherited: false,
							requiresRestart: true,
							description: "desc",
							options: ["webhook", "polling", "both"],
						},
						{
							key: "default_branch",
							value: "master",
							default: "main",
							override: "master",
							inherited: false,
							requiresRestart: false,
							description: "branch desc",
						},
					],
				});
			}
			if (url === "/api/repos/mbrooks/tars/settings" && init?.method === "PATCH") {
				return jsonResponse({ updated: ["github_event_mode"], requiresRestart: ["github_event_mode"] });
			}
			if (url === "/api/repos/mbrooks/tars" && init?.method === "DELETE") {
				return jsonResponse({ removed: true });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
	});

	afterEach(() => {
		window.location.hash = "";
	});

	it("renders repo settings", async () => {
		render(<RepoSettingsScreen owner="mbrooks" repo="tars" onBack={vi.fn()} onSelectTab={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("Repository Settings")).toBeDefined();
		});
		expect(screen.getByDisplayValue("polling")).toBeDefined();
		expect(screen.getByDisplayValue("master")).toBeDefined();
	});

	it("saves repo setting changes", async () => {
		render(<RepoSettingsScreen owner="mbrooks" repo="tars" onBack={vi.fn()} onSelectTab={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("Repository Settings")).toBeDefined();
		});
		fireEvent.change(screen.getByDisplayValue("polling"), { target: { value: "webhook" } });
		fireEvent.click(screen.getByText("Save Changes"));
		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith(
				"/api/repos/mbrooks/tars/settings",
				expect.objectContaining({ method: "PATCH" }),
			);
		});
		expect(screen.getByText("A restart is required for event mode changes to take effect.")).toBeDefined();
	});

	it("removes the repository after confirmation and navigates to repos", async () => {
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
		window.location.hash = "#/repos/mbrooks/tars/settings";
		render(<RepoSettingsScreen owner="mbrooks" repo="tars" onBack={vi.fn()} onSelectTab={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("Repository Settings")).toBeDefined();
		});

		fireEvent.click(screen.getByRole("button", { name: /remove repository/i }));

		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith("/api/repos/mbrooks/tars", { method: "DELETE" });
		});
		expect(window.location.hash).toBe("#/repos");
		confirmSpy.mockRestore();
	});

	it("does not remove the repository when confirmation is cancelled", async () => {
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
		render(<RepoSettingsScreen owner="mbrooks" repo="tars" onBack={vi.fn()} onSelectTab={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("Repository Settings")).toBeDefined();
		});

		fireEvent.click(screen.getByRole("button", { name: /remove repository/i }));

		expect(fetchSpy).not.toHaveBeenCalledWith(
			"/api/repos/mbrooks/tars",
			expect.objectContaining({ method: "DELETE" }),
		);
		confirmSpy.mockRestore();
	});

	it("displays an error when removal fails", async () => {
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
		render(<RepoSettingsScreen owner="mbrooks" repo="tars" onBack={vi.fn()} onSelectTab={vi.fn()} />);
		await waitFor(() => {
			expect(screen.getByText("Repository Settings")).toBeDefined();
		});

		fetchSpy.mockRejectedValueOnce(new Error("Remove failed"));
		fireEvent.click(screen.getByRole("button", { name: /remove repository/i }));

		await waitFor(() => {
			expect(screen.getByText("Remove failed")).toBeDefined();
		});
		confirmSpy.mockRestore();
	});
});
