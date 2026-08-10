// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

import { UsersScreen } from "./UsersScreen.js";

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const USER_FIXTURE = {
	id: "user-1",
	fullName: "Ada Lovelace",
	username: "ada",
	createdAt: "2026-08-01T00:00:00.000Z",
	updatedAt: "2026-08-01T00:00:00.000Z",
};

function mockListUsers(users: unknown[] = [USER_FIXTURE]) {
	return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
		const url = typeof input === "string" ? input : input.url;
		if (url === "/api/users") {
			return Promise.resolve(jsonResponse({ users }));
		}
		return Promise.reject(new Error(`Unexpected fetch: ${url}`));
	});
}

describe("UsersScreen", () => {
	beforeEach(() => {
		Object.defineProperty(window, "confirm", {
			value: vi.fn(() => true),
			writable: true,
			configurable: true,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders the user list and an Add User button but no inline add form", async () => {
		mockListUsers();

		render(<UsersScreen />);

		await waitFor(() => {
			expect(screen.getByText("Ada Lovelace")).not.toBeNull();
		});

		expect(screen.getByRole("button", { name: "Add User" })).not.toBeNull();
		// The add-user form is hidden inside a closed modal until opened.
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("opens the add-user modal when Add User is clicked", async () => {
		mockListUsers();

		render(<UsersScreen />);

		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Add User" })).not.toBeNull();
		});
		fireEvent.click(screen.getByRole("button", { name: "Add User" }));

		expect(screen.getByRole("dialog")).not.toBeNull();
		expect(screen.getByLabelText("Full name")).not.toBeNull();
		expect(screen.getByLabelText("Username")).not.toBeNull();
		expect(screen.getByLabelText("Password")).not.toBeNull();
		expect(screen.getByRole("button", { name: /Add user/ })).not.toBeNull();
		expect(screen.getByRole("button", { name: "Cancel" })).not.toBeNull();
	});

	it("closes the modal when Cancel is clicked", async () => {
		mockListUsers();

		render(<UsersScreen />);

		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Add User" })).not.toBeNull();
		});
		fireEvent.click(screen.getByRole("button", { name: "Add User" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});
	});

	it("creates a user from the modal and refreshes the list", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input.url;
			if (url === "/api/users" && init?.method !== "POST") {
				if (init?.method === "POST") {
					return jsonResponse(USER_FIXTURE);
				}
				return jsonResponse({ users: [USER_FIXTURE] });
			}
			if (url === "/api/users" && init?.method === "POST") {
				return jsonResponse(USER_FIXTURE);
			}
			return Promise.reject(new Error(`Unexpected fetch: ${url}`));
		});

		render(<UsersScreen />);

		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Add User" })).not.toBeNull();
		});
		fireEvent.click(screen.getByRole("button", { name: "Add User" }));

		fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Ada Lovelace" } });
		fireEvent.change(screen.getByLabelText("Username"), { target: { value: "ada" } });
		fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
		fireEvent.click(screen.getByRole("button", { name: /Add user/ }));

		const createCall = fetchSpy.mock.calls.find(([input, init]) => {
			const url = typeof input === "string" ? input : input.url;
			return url === "/api/users" && init?.method === "POST";
		});
		expect(createCall).toBeDefined();
		expect(JSON.parse(createCall![1].body as string)).toEqual({
			full_name: "Ada Lovelace",
			username: "ada",
			password: "secret",
		});

		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});
	});

	it("shows a validation error when required fields are missing", async () => {
		const fetchSpy = mockListUsers();

		render(<UsersScreen />);

		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Add User" })).not.toBeNull();
		});
		fireEvent.click(screen.getByRole("button", { name: "Add User" }));
		fireEvent.click(screen.getByRole("button", { name: /Add user/ }));

		expect(screen.getByText(/Full name, username, and password are required/)).not.toBeNull();
		expect(fetchSpy).not.toHaveBeenCalledWith("/api/users", expect.objectContaining({ method: "POST" }));
	});

	it("shows an empty state when there are no users", async () => {
		mockListUsers([]);

		render(<UsersScreen />);

		await waitFor(() => {
			expect(screen.getByText("No admin users.")).not.toBeNull();
		});
	});

	it("disables the delete button for the last remaining user", async () => {
		mockListUsers([USER_FIXTURE]);

		render(<UsersScreen />);

		const deleteButton = await screen.findByRole("button", { name: "Delete" });
		expect((deleteButton as HTMLButtonElement).disabled).toBe(true);
	});

	it("deletes a user after confirmation", async () => {
		const secondUser = { ...USER_FIXTURE, id: "user-2", username: "grace" };
		vi.spyOn(window, "confirm").mockReturnValue(true);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input.url;
			if (url === "/api/users/user-2" && init?.method === "DELETE") {
				return jsonResponse({ deleted: true });
			}
			if (url === "/api/users") {
				return jsonResponse({ users: [USER_FIXTURE, secondUser] });
			}
			return Promise.reject(new Error(`Unexpected fetch: ${url}`));
		});

		render(<UsersScreen />);

		const deleteButtons = await screen.findAllByRole("button", { name: "Delete" });
		// The first user's delete button is enabled because there is more than one user.
		expect((deleteButtons[0] as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(deleteButtons[0]);

		await waitFor(() => {
			expect(fetchSpy.mock.calls.some(([input, init]) => {
				const url = typeof input === "string" ? input : input.url;
				return url === "/api/users/user-1" && init?.method === "DELETE";
			})).toBe(true);
		});
	});

	it("renders a list-level error when listing fails", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "boom" }, 500));

		render(<UsersScreen />);

		await waitFor(() => {
			expect(screen.getByText(/HTTP 500/)).not.toBeNull();
		});
	});
});