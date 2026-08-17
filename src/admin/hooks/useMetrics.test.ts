// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useMetrics } from "./useMetrics.js";

function mockMetricsResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const sampleResponse = {
	windowDays: 7,
	buckets: [
		{
			date: "2026-08-01",
			sessions: { total: 1, complete: 1, failed: 0, cancelled: 0 },
			tokens: { available: true, input: 10, output: 5, total: 15, cost: 0.3 },
			runtimeMs: 60000,
		},
	],
	recent: [],
};

describe("useMetrics", () => {
	let fetchSpy: any;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			return mockMetricsResponse(sampleResponse);
		});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("starts in the loading state", () => {
		const { result } = renderHook(() => useMetrics());
		expect(result.current.status).toBe("loading");
		expect(result.current.data).toBeNull();
	});

	it("loads the metrics and transitions to ready", async () => {
		const { result } = renderHook(() => useMetrics());

		await waitFor(() => {
			expect(result.current.status).toBe("ready");
		});
		expect(result.current.data?.windowDays).toBe(7);
		expect(result.current.data?.buckets).toHaveLength(1);
		expect(fetchSpy).toHaveBeenCalledWith("/api/metrics");
	});

	it("forwards the days window to the fetch query", async () => {
		const { result } = renderHook(() => useMetrics(0, 30));

		await waitFor(() => {
			expect(result.current.status).toBe("ready");
		});
		expect(fetchSpy).toHaveBeenCalledWith("/api/metrics?days=30");
	});

	it("transitions to error when the fetch fails", async () => {
		fetchSpy.mockImplementation(async () => new Response("boom", { status: 500 }));

		const { result } = renderHook(() => useMetrics());

		await waitFor(() => {
			expect(result.current.status).toBe("error");
		});
		expect(result.current.error).toContain("500");
		expect(result.current.data).toBeNull();
	});

	it("reloads when the refresh token changes", async () => {
		const { result, rerender } = renderHook(({ token }: { token: number }) => useMetrics(token), { initialProps: { token: 0 } });

		await waitFor(() => {
			expect(result.current.status).toBe("ready");
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		fetchSpy.mockClear();
		rerender({ token: 1 });

		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalled();
		});
	});

	it("does not update state after unmount while a fetch is in flight", async () => {
		let resolveFetch: ((r: Response) => void) | null = null;
		fetchSpy.mockImplementation(async () => {
			return new Promise<Response>((resolve) => {
				resolveFetch = resolve;
			});
		});

		const { result, unmount } = renderHook(() => useMetrics());
		await Promise.resolve();
		unmount();
		expect(resolveFetch).not.toBeNull();
		resolveFetch!(mockMetricsResponse(sampleResponse));
		await Promise.resolve();
		await Promise.resolve();
		expect(result.current.status).toBe("loading");
	});

	it("handles non-Error rejections and surfaces a string error message", async () => {
		fetchSpy.mockRejectedValue("network down");
		const { result } = renderHook(() => useMetrics());

		await waitFor(() => {
			expect(result.current.status).toBe("error");
		});
		expect(result.current.error).toBe("network down");
	});

	it("does not update state after unmount when the fetch rejects", async () => {
		let rejectFetch: ((e: unknown) => void) | null = null;
		fetchSpy.mockImplementation(async () => {
			return new Promise<Response>((_resolve, reject) => {
				rejectFetch = reject;
			});
		});

		const { result, unmount } = renderHook(() => useMetrics());
		await Promise.resolve();
		unmount();
		expect(rejectFetch).not.toBeNull();
		rejectFetch!(new Error("boom"));
		await Promise.resolve();
		await Promise.resolve();
		expect(result.current.status).toBe("loading");
	});
});

describe("useMetrics polling", () => {
	let fetchSpy: any;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			return mockMetricsResponse(sampleResponse);
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		fetchSpy.mockRestore();
	});

	it("refreshes metrics when the polling interval fires", async () => {
		const { result } = renderHook(() => useMetrics());

		// Flush the initial load (effect + async fetch resolution).
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(result.current.status).toBe("ready");
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// Advance past the 30s polling interval; the timer callback re-loads.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30000);
		});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(result.current.status).toBe("ready");
	});
});
