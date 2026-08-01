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
			YEETOMATIC_SESSION_WS_URL: "ws://host.docker.internal:6767/yeetomatic-worker/ws?sessionKey=mbrooks%2Ftars%23418&token=test",
			YEETOMATIC_SESSION_KEY: "mbrooks/tars#418",
			YEETOMATIC_SOUL_PATH: "/app/SOUL.md",
			npm_package_version: "1.2.3",
		};

		await main();

		expect(runWorkerRuntime).toHaveBeenCalledWith({
			wsUrl: "ws://host.docker.internal:6767/yeetomatic-worker/ws?sessionKey=mbrooks%2Ftars%23418&token=test",
			sessionKey: "mbrooks/tars#418",
			soulPath: "/app/SOUL.md",
			workerVersion: "1.2.3",
		});
	});

	it("defaults the soul path when none is provided", async () => {
		process.env = {
			...originalEnv,
			YEETOMATIC_SESSION_WS_URL: "ws://host.docker.internal:6767/yeetomatic-worker/ws?sessionKey=mbrooks%2Ftars%23419&token=test",
			YEETOMATIC_SESSION_KEY: "mbrooks/tars#419",
		};

		await main();

		expect(runWorkerRuntime).toHaveBeenCalledWith(
			expect.objectContaining({ soulPath: "/app/SOUL.md" }),
		);
	});

	it("throws when required env vars are missing", async () => {
		const baseEnv = { ...originalEnv };
		delete baseEnv.YEETOMATIC_SESSION_WS_URL;
		delete baseEnv.YEETOMATIC_SESSION_KEY;
		process.env = { ...baseEnv };
		await expect(main()).rejects.toThrow("YEETOMATIC_SESSION_WS_URL is required");

		process.env = {
			...baseEnv,
			YEETOMATIC_SESSION_WS_URL: "ws://host.docker.internal:6767/yeetomatic-worker/ws?sessionKey=mbrooks%2Ftars%23420&token=test",
		};
		await expect(main()).rejects.toThrow("YEETOMATIC_SESSION_KEY is required");
	});
});
