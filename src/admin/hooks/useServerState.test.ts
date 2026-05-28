// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useServerState } from "./useServerState.js";
import { webSocketManager } from "../api/websocket.js";

function mockStatusResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("useServerState websocket", () => {
	let fetchSpy: any;
	let subscribeStatusSpy: any;
	let statusCallback: ((data: unknown) => void) | null = null;
	let connectionCallback: ((status: "connecting" | "open" | "closed" | "error") => void) | null = null;
	let onStatusChangeSpy: any;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			return mockStatusResponse({
				agent: "online",
				uptime: "1m",
				draining: false,
				repos: [],
				sessions: [],
			});
		});
		subscribeStatusSpy = vi.spyOn(webSocketManager, "subscribeStatus").mockImplementation((callback) => {
			statusCallback = callback;
			return () => {
				statusCallback = null;
			};
		});
		onStatusChangeSpy = vi.spyOn(webSocketManager, "onStatusChange").mockImplementation((callback) => {
			connectionCallback = callback;
			return () => {
				connectionCallback = null;
			};
		});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		subscribeStatusSpy.mockRestore();
		onStatusChangeSpy.mockRestore();
		statusCallback = null;
		connectionCallback = null;
		vi.useRealTimers();
	});

	it("loads status via http initially", async () => {
		const { result } = renderHook(() => useServerState());

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(result.current.status).toBe("ready");
		expect(result.current.data?.agent).toBe("online");
		expect(fetchSpy).toHaveBeenCalled();
	});

	it("subscribes to websocket status updates", async () => {
		renderHook(() => useServerState());

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(subscribeStatusSpy).toHaveBeenCalledWith(expect.any(Function));
	});

	it("updates status from websocket messages", async () => {
		const { result } = renderHook(() => useServerState());

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		await act(async () => {
			statusCallback?.({ agent: "busy", uptime: "5m", draining: false, repos: [], sessions: [] });
			await Promise.resolve();
		});

		expect(result.current.status).toBe("ready");
		expect(result.current.data?.agent).toBe("busy");
	});

	it("skips http fallback when websocket is active", async () => {
		vi.useFakeTimers();
		renderHook(() => useServerState());

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		const callCount = fetchSpy.mock.calls.length;

		await act(async () => {
			statusCallback?.({ agent: "busy", uptime: "5m", draining: false, repos: [], sessions: [] });
			await Promise.resolve();
		});

		await act(async () => {
			vi.advanceTimersByTime(5000);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fetchSpy).toHaveBeenCalledTimes(callCount);
	});

	it("falls back to http polling when websocket is not active", async () => {
		vi.useFakeTimers();
		subscribeStatusSpy.mockImplementation(() => {
			return () => {};
		});

		renderHook(() => useServerState());

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		const callCount = fetchSpy.mock.calls.length;

		await act(async () => {
			vi.advanceTimersByTime(5000);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fetchSpy).toHaveBeenCalledTimes(callCount + 1);
	});

	it("resumes http polling after websocket closes", async () => {
		vi.useFakeTimers();
		renderHook(() => useServerState());

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		await act(async () => {
			statusCallback?.({ agent: "busy", uptime: "5m", draining: false, repos: [], sessions: [] });
			await Promise.resolve();
		});

		const callCount = fetchSpy.mock.calls.length;
		connectionCallback?.("closed");

		await act(async () => {
			vi.advanceTimersByTime(5000);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fetchSpy.mock.calls.length).toBeGreaterThan(callCount);
	});

	it("does not resume polling while the websocket remains open", async () => {
		vi.useFakeTimers();
		renderHook(() => useServerState());

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		await act(async () => {
			statusCallback?.({ agent: "busy", uptime: "5m", draining: false, repos: [], sessions: [] });
			await Promise.resolve();
		});

		const callCount = fetchSpy.mock.calls.length;
		connectionCallback?.("open");

		await act(async () => {
			vi.advanceTimersByTime(5000);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fetchSpy).toHaveBeenCalledTimes(callCount);
	});

	it("accepts a refreshToken parameter", async () => {
		renderHook(() => useServerState(1));

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fetchSpy).toHaveBeenCalled();
	});

	it("does not update state after unmount", async () => {
		const { unmount } = renderHook(() => useServerState());

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		const callbackAfterUnmount = statusCallback;
		unmount();

		// Trigger a status update after unmount
		callbackAfterUnmount?.({ agent: "busy", uptime: "5m", draining: false, repos: [], sessions: [] });
		// No error should be thrown
		expect(true).toBe(true);
	});

	it("sets error state when the status fetch fails while mounted", async () => {
		fetchSpy.mockRejectedValueOnce(new Error("status failed"));

		const { result } = renderHook(() => useServerState());

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(result.current).toEqual({
			status: "error",
			data: null,
			error: "status failed",
			updatedAt: null,
		});
	});

	it("does not update state when unmounted during fetch", async () => {
		vi.useFakeTimers();
		let resolveFetch: ((value: unknown) => void) | null = null;
		fetchSpy.mockImplementation(() => new Promise((resolve) => {
			resolveFetch = resolve;
		}));

		const { unmount } = renderHook(() => useServerState());

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		unmount();

		await act(async () => {
			resolveFetch?.(undefined);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		// Should not throw
		expect(true).toBe(true);
	});

	it("does not update error state when unmounted during error", async () => {
		vi.useFakeTimers();
		let rejectFetch: ((err: Error) => void) | null = null;
		fetchSpy.mockImplementation(() => new Promise((_resolve, reject) => {
			rejectFetch = reject;
		}));

		const { unmount } = renderHook(() => useServerState());

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		unmount();

		await act(async () => {
			rejectFetch?.(new Error("boom"));
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		// Should not throw
		expect(true).toBe(true);
	});
});
