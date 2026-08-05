// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

import { OllamaSignInPanel } from "./OllamaSignInPanel.js";
import * as ollamaApi from "../../api/ollama.js";
import type { OllamaSignInStatus } from "../../api/ollama.js";

function signedIn(): OllamaSignInStatus {
	return {
		signedIn: true,
		user: "alice",
		message: "You are already signed in as user 'alice'",
	};
}

function notSignedIn(): OllamaSignInStatus {
	return {
		signedIn: false,
		signInUrl: "https://ollama.com/connect?name=x&key=y",
		message: "You need to be signed in.",
	};
}

function unreachable(): OllamaSignInStatus {
	return {
		signedIn: false,
		message: "Ollama container was not found.",
		error: "no such container",
	};
}

describe("OllamaSignInPanel", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi
			.spyOn(ollamaApi, "fetchOllamaSignInStatus")
			.mockResolvedValue(signedIn());
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("uses the default fetchOllamaSignInStatus fetcher when no fetchStatus prop is passed", async () => {
		render(<OllamaSignInPanel />);
		await waitFor(() =>
			expect(screen.queryByText("Signed in as")).not.toBeNull(),
		);
		expect(ollamaApi.fetchOllamaSignInStatus).toHaveBeenCalledTimes(1);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("uses the injected fetchStatus prop when provided", async () => {
		const injected = vi.fn(async (): Promise<OllamaSignInStatus> => notSignedIn());
		render(<OllamaSignInPanel fetchStatus={injected} containerName="custom-ollama" />);

		await waitFor(() =>
			expect(screen.queryByText("Not signed in.")).not.toBeNull(),
		);
		expect(injected).toHaveBeenCalledTimes(1);
		// The default fetcher must not be called when an injected fetcher is supplied.
		expect(ollamaApi.fetchOllamaSignInStatus).not.toHaveBeenCalled();
	});

	it("renders the sign-in URL and docker exec command when not signed in", async () => {
		render(<OllamaSignInPanel fetchStatus={vi.fn(async () => notSignedIn())} containerName="yeetomatic-ollama" />);

		await waitFor(() =>
			expect(screen.queryByText("Not signed in.")).not.toBeNull(),
		);
		expect(
			screen.queryByText("https://ollama.com/connect?name=x&key=y"),
		).not.toBeNull();
		const code = screen.getByText(
			"docker exec -it yeetomatic-ollama ollama login",
		);
		expect(code).not.toBeNull();
	});

	it("reports the signed-in user", async () => {
		render(<OllamaSignInPanel fetchStatus={vi.fn(async () => signedIn())} />);
		await waitFor(() =>
			expect(screen.queryByText("Signed in as")).not.toBeNull(),
		);
		expect(screen.queryByText("alice")).not.toBeNull();
	});

	it("renders the error / retry state when the container is unreachable", async () => {
		render(<OllamaSignInPanel fetchStatus={vi.fn(async () => unreachable())} />);
		await waitFor(() =>
			expect(
				screen.queryByText("Could not reach the Ollama container."),
			).not.toBeNull(),
		);
		expect(
			screen.queryByText(/Make sure the Ollama container is running/u),
		).not.toBeNull();
	});

	it("re-checks status via the injected fetcher when Re-check status is clicked", async () => {
		const injected = vi.fn(async (): Promise<OllamaSignInStatus> => signedIn());
		render(<OllamaSignInPanel fetchStatus={injected} />);
		await waitFor(() =>
			expect(screen.queryByText("Signed in as")).not.toBeNull(),
		);
		expect(injected).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: /Re-check status/u }));
		await waitFor(() => expect(injected).toHaveBeenCalledTimes(2));
	});

	it("surfaces an error banner when the fetcher throws", async () => {
		const injected = vi.fn(async (): Promise<OllamaSignInStatus> => {
			throw new Error("network down");
		});
		render(<OllamaSignInPanel fetchStatus={injected} />);
		await waitFor(() =>
			expect(screen.queryByText("network down")).not.toBeNull(),
		);
	});
});