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
			YOLO_SESSION_WS_URL: "ws://host.docker.internal:6767/yolomatic-worker/ws?sessionKey=mbrooks%2Fyolomatic%23418&token=test",
			YOLO_SESSION_KEY: "mbrooks/yolomatic#418",
			YOLO_SOUL_PATH: "/app/SOUL.md",
			npm_package_version: "1.2.3",
		};

		await main();

		expect(runWorkerRuntime).toHaveBeenCalledWith({
			wsUrl: "ws://host.docker.internal:6767/yolomatic-worker/ws?sessionKey=mbrooks%2Fyolomatic%23418&token=test",
			sessionKey: "mbrooks/yolomatic#418",
			soulPath: "/app/SOUL.md",
			workerVersion: "1.2.3",
		});
	});

	it("defaults the soul path when none is provided", async () => {
		process.env = {
			...originalEnv,
			YOLO_SESSION_WS_URL: "ws://host.docker.internal:6767/yolomatic-worker/ws?sessionKey=mbrooks%2Fyolomatic%23419&token=test",
			YOLO_SESSION_KEY: "mbrooks/yolomatic#419",
		};

		await main();

		expect(runWorkerRuntime).toHaveBeenCalledWith(
			expect.objectContaining({ soulPath: "/app/SOUL.md" }),
		);
	});

	it("throws when required env vars are missing", async () => {
		const baseEnv = { ...originalEnv };
		delete baseEnv.YOLO_SESSION_WS_URL;
		delete baseEnv.YOLO_SESSION_KEY;
		process.env = { ...baseEnv };
		await expect(main()).rejects.toThrow("YOLO_SESSION_WS_URL is required");

		process.env = {
			...baseEnv,
			YOLO_SESSION_WS_URL: "ws://host.docker.internal:6767/yolomatic-worker/ws?sessionKey=mbrooks%2Fyolomatic%23420&token=test",
		};
		await expect(main()).rejects.toThrow("YOLO_SESSION_KEY is required");
	});
});
