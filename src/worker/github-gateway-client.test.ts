import { describe, expect, it, vi } from "vitest";

import { callGitHubGateway, setGitHubGatewayTransport, type GatewayTransport } from "./github-gateway-client.js";

describe("github-gateway-client", () => {
	it("throws when no transport is installed", async () => {
		setGitHubGatewayTransport(undefined);
		await expect(callGitHubGateway("get_authenticated_user", {})).rejects.toThrow(
			"GitHub gateway transport is not available",
		);
	});

	it("routes the call through the installed transport and returns data on success", async () => {
		const transport: GatewayTransport = {
			call: vi.fn(async () => ({ ok: true, data: { login: "bot" } })),
		};
		setGitHubGatewayTransport(transport);
		try {
			const data = await callGitHubGateway("get_authenticated_user", {});
			expect(data).toEqual({ login: "bot" });
			expect(transport.call).toHaveBeenCalledWith({ tool: "get_authenticated_user", params: {} });
		} finally {
			setGitHubGatewayTransport(undefined);
		}
	});

	it("shares the installed transport across separate module instances", async () => {
		const transport: GatewayTransport = {
			call: vi.fn(async () => ({ ok: true, data: { number: 535 } })),
		};
		setGitHubGatewayTransport(transport);

		try {
			vi.resetModules();
			const isolatedClient = await import("./github-gateway-client.js");

			expect(isolatedClient.setGitHubGatewayTransport).not.toBe(setGitHubGatewayTransport);
			await expect(isolatedClient.callGitHubGateway("fetch_issue", {})).resolves.toEqual({ number: 535 });
			expect(transport.call).toHaveBeenCalledWith({ tool: "fetch_issue", params: {} });
		} finally {
			setGitHubGatewayTransport(undefined);
		}
	});

	it("prefixes scope errors distinctly from generic gateway errors", async () => {
		const transport: GatewayTransport = {
			call: vi.fn(async () => ({ ok: false, error: "pr_number 9 is out of scope", scopeError: true })),
		};
		setGitHubGatewayTransport(transport);
		try {
			await expect(callGitHubGateway("fetch_pr", { pr_number: 9 })).rejects.toThrow(
				"GitHub scope error: pr_number 9 is out of scope",
			);
		} finally {
			setGitHubGatewayTransport(undefined);
		}
	});

	it("throws a generic gateway error when scopeError is not set", async () => {
		const transport: GatewayTransport = {
			call: vi.fn(async () => ({ ok: false, error: "boom" })),
		};
		setGitHubGatewayTransport(transport);
		try {
			await expect(callGitHubGateway("set_comment", { body: "x" })).rejects.toThrow("GitHub gateway error: boom");
		} finally {
			setGitHubGatewayTransport(undefined);
		}
	});

	it("falls back to a prefix-only message when the error is absent", async () => {
		const transport: GatewayTransport = {
			call: vi.fn(async () => ({ ok: false })),
		};
		setGitHubGatewayTransport(transport);
		try {
			await expect(callGitHubGateway("set_comment", { body: "x" })).rejects.toThrow("GitHub gateway error");
		} finally {
			setGitHubGatewayTransport(undefined);
		}
	});
});
