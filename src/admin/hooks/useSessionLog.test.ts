// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSessionLog } from "./useSessionLog.js";
import { webSocketManager } from "../api/websocket.js";

function mockLogResponse(overrides: Record<string, unknown> = {}) {
	return async (input: RequestInfo | URL) => {
		const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
		const since = url.searchParams.get("since");
		const baseLogs = (overrides.logs as { timestamp: string }[]) ?? [
			{ timestamp: "2025-01-01T00:00:00.000Z", level: "info", message: "line 1" },
			{ timestamp: "2025-01-01T00:00:01.000Z", level: "info", message: "line 2" },
		];
		const filtered = since ? baseLogs.filter((l) => l.timestamp > since) : baseLogs;
		return new Response(
			JSON.stringify({
				available: true,
				logs: filtered,
			}),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		);
	};
}

function makeSession(status: "working" | "pending" | "waiting-feedback" | "complete" | "failed" | "cancelled") {
	return {
		owner: "mbrooks",
		repo: "tars",
		issueNumber: 1,
		status,
		workspacePath: "/ws/1",
		branch: "tars/issue-1",
		lastActivity: new Date().toISOString(),
		createdAt: new Date(Date.now() - 3600000).toISOString(),
		prUrl: null,
		prNumber: null,
		risk: { suspectedMisroute: false, reasons: [], referencedIssueNumber: null },
		staleDetectedAt: null,
		staleReason: null,
		stale: null,
		taskStartedAt: null,
		taskFinishedAt: null,
		totalExecutionTimeMs: null,
	};
}

describe("useSessionLog websocket", () => {
	let fetchSpy: any;
	let subscribeLogSpy: any;
	let logCallback: ((entry: { timestamp: string; level: "info" | "error" | "warn" | "tool" | "assistant"; message: string }) => void) | null = null;
	let connectionCallback: ((status: "connecting" | "open" | "closed" | "error") => void) | null = null;
	let onStatusChangeSpy: any;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(mockLogResponse());
		subscribeLogSpy = vi.spyOn(webSocketManager, "subscribeLog").mockImplementation(
			(_owner, _repo, _issueNumber, callback) => {
				logCallback = callback;
				return () => {
					logCallback = null;
				};
			},
		);
		onStatusChangeSpy = vi.spyOn(webSocketManager, "onStatusChange").mockImplementation((callback) => {
			connectionCallback = callback;
			return () => {
				connectionCallback = null;
			};
		});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		subscribeLogSpy.mockRestore();
		onStatusChangeSpy.mockRestore();
		logCallback = null;
		connectionCallback = null;
		vi.useRealTimers();
	});

	it("subscribes to websocket log channel", async () => {
		renderHook(() => useSessionLog(makeSession("working")));

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(subscribeLogSpy).toHaveBeenCalledWith("mbrooks", "tars", 1, expect.any(Function));
	});

	it("appends log entries received via websocket", async () => {
		const { result } = renderHook(() => useSessionLog(makeSession("working")));

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(result.current.status).toBe("ready");
		const initialLen = result.current.logs.length;

		await act(async () => {
			logCallback?.({ timestamp: "2025-01-01T00:00:02.000Z", level: "info", message: "ws line" });
			await Promise.resolve();
		});

		expect(result.current.logs).toHaveLength(initialLen + 1);
		expect(result.current.logs[initialLen].message).toBe("ws line");
	});

	it("stops polling when websocket is connected and session is working", async () => {
		vi.useFakeTimers();
		renderHook(() => useSessionLog(makeSession("working")));

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		// Simulate websocket connected by sending a log entry
		await act(async () => {
			logCallback?.({ timestamp: "2025-01-01T00:00:02.000Z", level: "info", message: "ws line" });
			await Promise.resolve();
		});

		const callCountBefore = fetchSpy.mock.calls.length;

		await act(async () => {
			vi.advanceTimersByTime(2500);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		// Fallback polling should still run, but wsConnectedRef is set, so fetch is skipped
		expect(fetchSpy).toHaveBeenCalledTimes(callCountBefore);
	});

	it("returns idle state when no session is provided", async () => {
		const { result } = renderHook(() => useSessionLog(null));
		expect(result.current.status).toBe("idle");
		expect(subscribeLogSpy).not.toHaveBeenCalled();
	});

	it("handles fetch error on initial load", async () => {
		fetchSpy.mockImplementation(async () => {
			return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
		});

		const { result } = renderHook(() => useSessionLog(makeSession("working")));

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(result.current.status).toBe("error");
		expect(result.current.error).toContain("500");
	});

	it("handles empty log response on initial load", async () => {
		fetchSpy.mockImplementation(async () => {
			return new Response(JSON.stringify({ available: true, logs: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const { result } = renderHook(() => useSessionLog(makeSession("working")));

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(result.current.status).toBe("ready");
		expect(result.current.logs).toHaveLength(0);
	});

	it("resets state when session changes", async () => {
		const { rerender, result } = renderHook(
			({ session }) => useSessionLog(session),
			{ initialProps: { session: makeSession("working") } },
		);

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(result.current.status).toBe("ready");
		const firstCount = result.current.logs.length;

		await act(async () => {
			rerender({ session: { ...makeSession("working"), issueNumber: 2 } });
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(result.current.status).toBe("ready");
		expect(result.current.logs.length).toBeGreaterThanOrEqual(0);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("resumes polling after websocket closes", async () => {
		vi.useFakeTimers();
		renderHook(() => useSessionLog(makeSession("working")));

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		await act(async () => {
			logCallback?.({ timestamp: "2025-01-01T00:00:02.000Z", level: "info", message: "ws line" });
			await Promise.resolve();
		});

		const callCount = fetchSpy.mock.calls.length;
		connectionCallback?.("closed");

		await act(async () => {
			vi.advanceTimersByTime(2500);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fetchSpy.mock.calls.length).toBeGreaterThan(callCount);
	});

	it("does not fetch when paused", async () => {
		renderHook(() => useSessionLog(makeSession("working"), true));

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
