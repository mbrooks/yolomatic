// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

import { SettingsScreen } from "./SettingsScreen.js";

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("SettingsScreen", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		window.location.hash = "";
	});

	it("renders loading state on general tab", () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		render(<SettingsScreen onBack={vi.fn()} tab="general" />);
		expect(screen.getByText("Loading settings...")).not.toBeNull();
	});

	it("renders settings list on general tab", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				settings: [
					{
						key: "test_key",
						value: "test_value",
						description: "Test description",
						type: "string",
						default: "default_value",
						requiresRestart: false,
						sensitive: false,
					},
				],
			}),
		);
		render(<SettingsScreen onBack={vi.fn()} tab="general" />);

		await waitFor(() => {
			expect(screen.getByText("test_key")).not.toBeNull();
		});
		expect(screen.getByText("Test description")).not.toBeNull();
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
		render(<SettingsScreen onBack={vi.fn()} tab="general" />);

		const invitationsButton = screen.getByRole("button", { name: "Invitations" });
		fireEvent.click(invitationsButton);

		expect(window.location.hash).toBe("#/settings/invitations");
	});

	it("navigates to skills tab when skills button is clicked", () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		render(<SettingsScreen onBack={vi.fn()} tab="general" />);

		const skillsButton = screen.getByRole("button", { name: "Skills" });
		fireEvent.click(skillsButton);

		expect(window.location.hash).toBe("#/settings/skills");
	});

	it("calls onBack when back button is clicked", () => {
		const onBack = vi.fn();
		vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		render(<SettingsScreen onBack={onBack} tab="general" />);

		fireEvent.click(screen.getByRole("button", { name: /Back/ }));
		expect(onBack).toHaveBeenCalledTimes(1);
	});
});
