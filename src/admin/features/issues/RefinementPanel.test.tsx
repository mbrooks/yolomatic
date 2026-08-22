// @vitest-environment happy-dom
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { RefinementPanel } from "./RefinementPanel.js";

const mockFetchRefinementLog = vi.fn();
const mockFetchRefinementAttempts = vi.fn();

vi.mock("../../api/refinements.js", () => ({
	fetchRefinementLog: (...args: unknown[]) => mockFetchRefinementLog(...args),
	fetchRefinementAttempts: (...args: unknown[]) => mockFetchRefinementAttempts(...args),
}));

vi.mock("../../api/websocket.js", () => ({
	webSocketManager: {
		subscribeLog: () => () => {},
		onStatusChange: () => () => {},
	},
}));

describe("RefinementPanel", () => {
	beforeEach(() => {
		mockFetchRefinementLog.mockReset();
		mockFetchRefinementAttempts.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders attempts and log entries", async () => {
		mockFetchRefinementAttempts.mockResolvedValue({
			attempts: [
				{
					id: "a1",
					requester: "admin",
					instructionSource: "repository-skill",
					repoCommit: "abc123",
					state: "applied",
					summary: "Clarified requirements",
					createdAt: new Date(Date.now() - 60_000).toISOString(),
					updatedAt: new Date().toISOString(),
				},
			],
		});
		mockFetchRefinementLog.mockResolvedValue({
			available: true,
			logs: [
				{ timestamp: "2026-08-01T00:00:00.000Z", level: "info", message: "Refinement started" },
				{ timestamp: "2026-08-01T00:00:01.000Z", level: "info", message: "Applied refined issue body" },
			],
		});

		render(<RefinementPanel owner="mbrooks" repo="yolomatic" issueNumber={1} />);

		await waitFor(() => expect(mockFetchRefinementAttempts).toHaveBeenCalled());
		await waitFor(() => expect(screen.getByText("applied")).toBeDefined());
		expect(screen.getByText("@admin")).toBeDefined();
		expect(screen.getByText("repo skill")).toBeDefined();
		expect(screen.getByText("Clarified requirements")).toBeDefined();
		expect(screen.getByText("Refinement started")).toBeDefined();
		expect(screen.getByText("Applied refined issue body")).toBeDefined();
	});

	it("shows no-activity message when nothing has been refined", async () => {
		mockFetchRefinementAttempts.mockResolvedValue({ attempts: [] });
		mockFetchRefinementLog.mockResolvedValue({ available: false, logs: [] });

		render(<RefinementPanel owner="mbrooks" repo="yolomatic" issueNumber={2} />);

		await waitFor(() =>
			expect(screen.getByText("No refinement activity for this issue.")).toBeDefined(),
		);
	});

	it("shows a failure reason for a failed attempt", async () => {
		mockFetchRefinementAttempts.mockResolvedValue({
			attempts: [
				{
					id: "a2",
					requester: "admin",
					instructionSource: "prompt-defaults",
					state: "failed",
					failureReason: "worker crashed",
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
			],
		});
		mockFetchRefinementLog.mockResolvedValue({ available: true, logs: [] });

		render(<RefinementPanel owner="mbrooks" repo="yolomatic" issueNumber={3} />);

		await waitFor(() => expect(screen.getByText("failed")).toBeDefined());
		expect(screen.getByText("worker crashed")).toBeDefined();
	});

	it("renders runtime and token usage for an attempt", async () => {
		mockFetchRefinementAttempts.mockResolvedValue({
			attempts: [
				{
					id: "a3",
					requester: "admin",
					instructionSource: "repository-skill",
					state: "applied",
					summary: "Clarified requirements",
					runtimeMs: 90_000,
					tokenUsage: { available: true, input: 100, output: 40, totalTokens: 140, cost: 0.9 },
					createdAt: new Date(Date.now() - 60_000).toISOString(),
					updatedAt: new Date().toISOString(),
				},
			],
		});
		mockFetchRefinementLog.mockResolvedValue({ available: true, logs: [] });

		render(<RefinementPanel owner="mbrooks" repo="yolomatic" issueNumber={4} />);

		await waitFor(() => expect(screen.getByText("applied")).toBeDefined());
		expect(screen.getByText("1m")).toBeDefined();
		expect(screen.getByText("140")).toBeDefined();
	});

	it("renders unknown token usage when usage is unavailable", async () => {
		mockFetchRefinementAttempts.mockResolvedValue({
			attempts: [
				{
					id: "a4",
					requester: "admin",
					instructionSource: "prompt-defaults",
					state: "failed",
					runtimeMs: 5_000,
					tokenUsage: { available: false, input: 0, output: 0, totalTokens: 0, cost: 0 },
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
			],
		});
		mockFetchRefinementLog.mockResolvedValue({ available: true, logs: [] });

		render(<RefinementPanel owner="mbrooks" repo="yolomatic" issueNumber={5} />);

		await waitFor(() => expect(screen.getByText("failed")).toBeDefined());
		expect(screen.getByText("unknown")).toBeDefined();
	});
});