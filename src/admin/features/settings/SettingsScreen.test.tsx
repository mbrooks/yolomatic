// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

import { SettingsScreen } from "./SettingsScreen.js";
import { DEFAULT_SETTINGS_TAB } from "../../app/routes.js";

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const MOCK_SETTINGS = [
	{
		key: "github_token",
		value: "ghp_token",
		description: "GitHub personal access token",
		type: "string",
		default: undefined,
		requiresRestart: true,
		sensitive: true,
		updatedAt: "2026-06-15T00:00:00.000Z",
		category: "github-integration",
	},
	{
		key: "github_username",
		value: "tars-bot",
		description: "GitHub username",
		type: "string",
		default: undefined,
		requiresRestart: true,
		sensitive: false,
		updatedAt: "2026-06-15T00:00:00.000Z",
		category: "github-integration",
	},
	{
		key: "admin_username",
		value: "admin",
		description: "Admin UI username",
		type: "string",
		default: undefined,
		requiresRestart: true,
		sensitive: false,
		updatedAt: "2026-06-15T00:00:00.000Z",
		category: "authentication",
	},
	{
		key: "port",
		value: 6767,
		description: "HTTP server port",
		type: "number",
		default: 6767,
		requiresRestart: true,
		sensitive: false,
		updatedAt: "2026-06-15T00:00:00.000Z",
		category: "server",
	},
	{
		key: "self_report_enabled",
		value: true,
		description: "Enable self-monitoring reports",
		type: "boolean",
		default: true,
		requiresRestart: false,
		sensitive: false,
		updatedAt: "2026-06-15T00:00:00.000Z",
		category: "agent-behavior",
	},
];

function mockSettingsFetch() {
	return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
		const url = typeof input === "string" ? input : input.url;
		if (url === "/api/settings") {
			return Promise.resolve(jsonResponse({ settings: MOCK_SETTINGS }));
		}
		return Promise.reject(new Error(`Unexpected fetch: ${url}`));
	});
}

function mockFetchWithSave(response: { updated: string[]; requiresRestart: string[] } = { updated: [], requiresRestart: [] }) {
	return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
		const url = typeof input === "string" ? input : input.url;
		if (url === "/api/settings" && init?.method === "PATCH") {
			return Promise.resolve(jsonResponse(response));
		}
		if (url === "/api/settings") {
			return Promise.resolve(jsonResponse({ settings: MOCK_SETTINGS }));
		}
		return Promise.reject(new Error(`Unexpected fetch: ${url}`));
	});
}

describe("SettingsScreen", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		window.location.hash = "";
	});

	it("renders loading state on default category tab", () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		render(<SettingsScreen onBack={vi.fn()} tab={DEFAULT_SETTINGS_TAB} />);
		expect(screen.getByText("Loading settings...")).not.toBeNull();
	});

	it("renders settings filtered by active category tab", async () => {
		mockSettingsFetch();
		render(<SettingsScreen onBack={vi.fn()} tab="github-integration" />);

		await waitFor(() => {
			expect(screen.getByText("github_token")).not.toBeNull();
		});
		expect(screen.getByText("github_username")).not.toBeNull();
		expect(screen.queryByText("admin_username")).toBeNull();
		expect(screen.queryByText("port")).toBeNull();
	});

	it("switches category tab and filters settings", async () => {
		mockSettingsFetch();
		const { rerender } = render(<SettingsScreen onBack={vi.fn()} tab="github-integration" />);

		await waitFor(() => {
			expect(screen.getByText("github_token")).not.toBeNull();
		});

		fireEvent.click(screen.getByRole("button", { name: "Authentication" }));
		expect(window.location.hash).toBe("#/settings/authentication");

		rerender(<SettingsScreen onBack={vi.fn()} tab="authentication" />);

		await waitFor(() => {
			expect(screen.getByText("admin_username")).not.toBeNull();
		});
		expect(screen.queryByText("github_token")).toBeNull();
	});

	it("renders skills tab", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ skills: [] }),
		);
		render(<SettingsScreen onBack={vi.fn()} tab="skills" />);

		await waitFor(() => {
			expect(screen.getByText("No server-level skills defined.")).not.toBeNull();
		});
	});

	it("renders invitations tab", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ invitations: [] }),
		);
		render(<SettingsScreen onBack={vi.fn()} tab="invitations" />);

		await waitFor(() => {
			expect(screen.getByText("No pending invitations.")).not.toBeNull();
		});
	});

	it("navigates to invitations tab when invitations button is clicked", () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		render(<SettingsScreen onBack={vi.fn()} tab={DEFAULT_SETTINGS_TAB} />);

		const invitationsButton = screen.getByRole("button", { name: "Invitations" });
		fireEvent.click(invitationsButton);

		expect(window.location.hash).toBe("#/settings/invitations");
	});

	it("navigates to skills tab when skills button is clicked", () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		render(<SettingsScreen onBack={vi.fn()} tab={DEFAULT_SETTINGS_TAB} />);

		const skillsButton = screen.getByRole("button", { name: "Skills" });
		fireEvent.click(skillsButton);

		expect(window.location.hash).toBe("#/settings/skills");
	});

	it("navigates to default category tab when no tab is provided", () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		render(<SettingsScreen onBack={vi.fn()} />);

		const defaultButton = screen.getByRole("button", { name: "GitHub Integration" });
		expect(defaultButton).not.toBeNull();
		expect(defaultButton.className).toContain("active");
	});

	it("calls onBack when back button is clicked", () => {
		const onBack = vi.fn();
		vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		render(<SettingsScreen onBack={onBack} tab={DEFAULT_SETTINGS_TAB} />);

		fireEvent.click(screen.getByRole("button", { name: /Back/ }));
		expect(onBack).toHaveBeenCalledTimes(1);
	});

	it("marks a row dirty and enables save when a value is edited", async () => {
		mockSettingsFetch();
		render(<SettingsScreen onBack={vi.fn()} tab="github-integration" />);

		await waitFor(() => {
			expect(screen.getByDisplayValue("tars-bot")).not.toBeNull();
		});

		const input = screen.getByDisplayValue("tars-bot") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "new-bot" } });

		expect(input.parentElement?.classList.contains("dirty")).toBe(true);
		expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(false);
	});

	it("saves changes and refreshes settings", async () => {
		const fetchSpy = mockFetchWithSave({ updated: ["github_username"], requiresRestart: [] });
		render(<SettingsScreen onBack={vi.fn()} tab="github-integration" />);

		await waitFor(() => {
			expect(screen.getByDisplayValue("tars-bot")).not.toBeNull();
		});

		fireEvent.change(screen.getByDisplayValue("tars-bot"), { target: { value: "new-bot" } });
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

		await waitFor(() => {
			expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(true);
		});

		const patchCall = fetchSpy.mock.calls.find(([input, init]) => {
			const url = typeof input === "string" ? input : input.url;
			return url === "/api/settings" && init?.method === "PATCH";
		});
		expect(patchCall).toBeDefined();
		const body = JSON.parse(patchCall![1].body as string);
		expect(body).toEqual({ github_username: "new-bot" });
	});
});
