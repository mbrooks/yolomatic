// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useRefinementLog } from "./useRefinementLog.js";
import { webSocketManager } from "../api/websocket.js";

interface FetchHandler {
	(url: URL): Response;
}

function makeFetchHandler(handler: FetchHandler): (input: RequestInfo | URL) => Promise<Response> {
	return async (input) => handler(new URL(typeof input === "string" ? input : input.toString(), "http://localhost"));
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function flush(): Promise<void> {
	for (let i = 0; i < 6; i += 1) {
		// eslint-disable-next-line no-await-in-loop
		await Promise.resolve();
	}
}

describe("useRefinementLog", () => {
	let fetchSpy: any;
	let subscribeLogSpy: any;
	let onStatusChangeSpy: any;
	let logCallback:
		| ((entry: { timestamp: string; level: "info" | "error" | "warn"; message: string }) => void)
		| null = null;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch");
		subscribeLogSpy = vi.spyOn(webSocketManager, "subscribeLog").mockImplementation(
			(_owner, _repo, _issueNumber, callback) => {
				logCallback = callback;
				return () => {
					logCallback = null;
				};
			},
		);
		onStatusChangeSpy = vi.spyOn(webSocketManager, "onStatusChange").mockImplementation(() => () => {});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		subscribeLogSpy.mockRestore();
		onStatusChangeSpy.mockRestore();
		logCallback = null;
	});

	it("loads attempts and logs on mount", async () => {
		fetchSpy.mockImplementation(
			makeFetchHandler((url) => {
				if (url.pathname.endsWith("/attempts")) {
					return jsonResponse({
						attempts: [
							{
								id: "a1",
								requester: "admin",
								instructionSource: "prompt-defaults",
								state: "applied",
								createdAt: "2026-08-01T00:00:00.000Z",
								updatedAt: "2026-08-01T00:00:01.000Z",
							},
						],
					});
				}
				return jsonResponse({
					available: true,
					logs: [{ timestamp: "2026-08-01T00:00:00.000Z", level: "info", message: "Refinement started" }],
				});
			}),
		);

		const { result } = renderHook(() => useRefinementLog("mbrooks", "yeetomatic", 1));

		await act(async () => {
			await flush();
		});

		await waitFor(() => expect(result.current.status).toBe("ready"));
		expect(result.current.attempts).toHaveLength(1);
		expect(result.current.attempts[0].state).toBe("applied");
		expect(result.current.logs.some((l) => l.message === "Refinement started")).toBe(true);
		expect(subscribeLogSpy).toHaveBeenCalledWith("mbrooks", "yeetomatic", 1, expect.any(Function));
	});

	it("appends log entries received via websocket", async () => {
		fetchSpy.mockImplementation(
			makeFetchHandler((url) =>
				url.pathname.endsWith("/attempts")
					? jsonResponse({ attempts: [] })
					: jsonResponse({ available: false, logs: [] }),
			),
		);

		const { result } = renderHook(() => useRefinementLog("mbrooks", "yeetomatic", 2));

		await act(async () => {
			await flush();
		});

		await waitFor(() => expect(result.current.status).toBe("ready"));
		expect(result.current.logs).toHaveLength(0);

		await act(async () => {
			logCallback?.({ timestamp: "2026-08-01T00:00:05.000Z", level: "info", message: "ws line" });
			await flush();
		});

		expect(result.current.logs).toHaveLength(1);
		expect(result.current.logs[0].message).toBe("ws line");
	});

	it("reports no activity when attempts and logs are empty", async () => {
		fetchSpy.mockImplementation(
			makeFetchHandler((url) =>
				url.pathname.endsWith("/attempts")
					? jsonResponse({ attempts: [] })
					: jsonResponse({ available: false, logs: [] }),
			),
		);

		const { result } = renderHook(() => useRefinementLog("mbrooks", "yeetomatic", 3));

		await act(async () => {
			await flush();
		});

		await waitFor(() => expect(result.current.status).toBe("ready"));
		expect(result.current.attempts).toEqual([]);
		expect(result.current.logs).toEqual([]);
	});

	it("is idle when issueNumber is null", async () => {
		fetchSpy.mockImplementation(makeFetchHandler(() => jsonResponse({ available: false, logs: [] })));
		const { result } = renderHook(() => useRefinementLog("mbrooks", "yeetomatic", null));

		await act(async () => {
			await flush();
		});

		expect(result.current.status).toBe("idle");
		expect(subscribeLogSpy).not.toHaveBeenCalled();
	});

	it("records an error when the attempts fetch rejects", async () => {
		fetchSpy.mockImplementation(
			makeFetchHandler((url) => {
				if (url.pathname.endsWith("/attempts")) {
					throw new Error("attempts failed");
				}
				return jsonResponse({ available: false, logs: [] });
			}),
		);

		const { result } = renderHook(() => useRefinementLog("mbrooks", "yeetomatic", 4));

		await act(async () => {
			await flush();
		});

		await waitFor(() => expect(result.current.status).toBe("ready"));
		expect(result.current.attempts).toEqual([]);
	});

	it("records an error when the log fetch rejects", async () => {
		fetchSpy.mockImplementation(
			makeFetchHandler((url) => {
				if (url.pathname.endsWith("/log")) {
					throw new Error("log failed");
				}
				return jsonResponse({ attempts: [] });
			}),
		);

		const { result } = renderHook(() => useRefinementLog("mbrooks", "yeetomatic", 5));

		await act(async () => {
			await flush();
		});

		await waitFor(() => expect(result.current.error).toContain("log failed"));
		expect(result.current.status).toBe("error");
	});

	it("polls again when the websocket is not connected", async () => {
		vi.useFakeTimers();
		fetchSpy.mockImplementation(
			makeFetchHandler((url) =>
				url.pathname.endsWith("/attempts")
					? jsonResponse({ attempts: [] })
					: jsonResponse({ available: false, logs: [] }),
			),
		);

		renderHook(() => useRefinementLog("mbrooks", "yeetomatic", 6));

		await act(async () => {
			await flush();
		});

		const callsAfterMount = fetchSpy.mock.calls.length;

		await act(async () => {
			vi.advanceTimersByTime(6000);
			await flush();
		});

		expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsAfterMount);
		vi.useRealTimers();
	});
});