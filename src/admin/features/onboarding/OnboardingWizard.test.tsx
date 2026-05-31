// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

import { OnboardingWizard } from "./OnboardingWizard.js";

function mockOkResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("OnboardingWizard", () => {
	let fetchSpy: any;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			return mockOkResponse({ success: true, requiresRestart: ["github_token"] });
		});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("renders form fields", () => {
		render(<OnboardingWizard />);
		expect(screen.queryByText("Welcome to TARS")).not.toBeNull();
		expect(screen.queryByLabelText("GitHub Token")).not.toBeNull();
		expect(screen.queryByLabelText("GitHub Username")).not.toBeNull();
		expect(screen.queryByLabelText("Webhook Secret")).not.toBeNull();
		expect(screen.queryByLabelText("Admin Username")).not.toBeNull();
		expect(screen.queryByLabelText("Admin Password")).not.toBeNull();
	});

	it("submits onboarding data on form submit", async () => {
		render(<OnboardingWizard />);

		fireEvent.change(screen.getByLabelText("GitHub Token"), { target: { value: "tok" } });
		fireEvent.change(screen.getByLabelText("GitHub Username"), { target: { value: "user" } });
		fireEvent.change(screen.getByLabelText("Webhook Secret"), { target: { value: "sec" } });
		fireEvent.change(screen.getByLabelText("Admin Username"), { target: { value: "admin" } });
		fireEvent.change(screen.getByLabelText("Admin Password"), { target: { value: "pass" } });

		fireEvent.click(screen.getByText("Save and Finish"));

		await waitFor(() => {
			expect(screen.queryByText("Setup Complete")).not.toBeNull();
		});

		const calls = fetchSpy.mock.calls as [string, RequestInit][];
		const lastCall = calls[calls.length - 1];
		expect(lastCall[0]).toBe("/api/onboarding");
		expect(lastCall[1].method).toBe("POST");
		const body = JSON.parse(lastCall[1].body as string);
		expect(body.github_token).toBe("tok");
		expect(body.admin_username).toBe("admin");
	});
});
