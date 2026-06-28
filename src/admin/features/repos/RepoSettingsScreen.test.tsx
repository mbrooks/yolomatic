// @vitest-environment happy-dom
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
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
			throw new Error(`Unexpected fetch: ${url}`);
		});
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
});
