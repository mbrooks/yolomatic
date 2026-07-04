import { afterEach, describe, expect, it, vi } from "vitest";

const { runWorkerRuntime } = vi.hoisted(() => ({
	runWorkerRuntime: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
	runWorkerRuntime,
}));

import { main } from "./entrypoint.js";

describe("worker entrypoint", () => {
	const originalEnv = process.env;

	afterEach(() => {
		process.env = originalEnv;
		vi.clearAllMocks();
	});

	it("passes required env into the worker runtime", async () => {
		process.env = {
			...originalEnv,
			TARS_SESSION_SOCKET_PATH: "/tmp/session.sock",
			TARS_SESSION_KEY: "mbrooks/tars#418",
			TARS_SOUL_PATH: "/app/SOUL.md",
			npm_package_version: "1.2.3",
		};

		await main();

		expect(runWorkerRuntime).toHaveBeenCalledWith({
			socketPath: "/tmp/session.sock",
			sessionKey: "mbrooks/tars#418",
			soulPath: "/app/SOUL.md",
			workerVersion: "1.2.3",
		});
	});

	it("defaults the soul path when none is provided", async () => {
		process.env = {
			...originalEnv,
			TARS_SESSION_SOCKET_PATH: "/tmp/session.sock",
			TARS_SESSION_KEY: "mbrooks/tars#419",
		};

		await main();

		expect(runWorkerRuntime).toHaveBeenCalledWith(
			expect.objectContaining({ soulPath: "/app/SOUL.md" }),
		);
	});

	it("throws when required env vars are missing", async () => {
		process.env = { ...originalEnv };
		await expect(main()).rejects.toThrow("TARS_SESSION_SOCKET_PATH is required");

		process.env = {
			...originalEnv,
			TARS_SESSION_SOCKET_PATH: "/tmp/session.sock",
		};
		await expect(main()).rejects.toThrow("TARS_SESSION_KEY is required");
	});
});
