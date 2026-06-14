// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueChatPayload, IssueChatProgressEvent, IssueChatResponse } from "../../api/issues.js";
import { webSocketManager } from "../../api/websocket.js";
import { useIssueChatTransport } from "./useIssueChatTransport.js";

function mockJsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const payload: IssueChatPayload = {
	owner: "mbrooks",
	repo: "tars",
	messages: [{ role: "user", text: "Draft an issue" }],
};

const response: IssueChatResponse = {
	message: "Ready",
	owner: "mbrooks",
	repo: "tars",
	draft: { title: "Title", body: "Body", labels: [], assignees: [] },
	readyToCreate: true,
	shouldCreate: false,
};

describe("useIssueChatTransport", () => {
	let fetchSpy: any;
	let statusSpy: any;
	let onStatusChangeSpy: any;
	let subscribeStatusSpy: any;
	let requestIssueChatSpy: any;
	let abortIssueChatSpy: any;
	let steerIssueChatSpy: any;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch");
		statusSpy = vi.spyOn(webSocketManager, "connectionStatus", "get");
		onStatusChangeSpy = vi.spyOn(webSocketManager, "onStatusChange").mockReturnValue(() => undefined);
		subscribeStatusSpy = vi.spyOn(webSocketManager, "subscribeStatus").mockReturnValue(() => undefined);
		requestIssueChatSpy = vi.spyOn(webSocketManager, "requestIssueChat");
		abortIssueChatSpy = vi.spyOn(webSocketManager, "abortIssueChat");
		steerIssueChatSpy = vi.spyOn(webSocketManager, "steerIssueChat");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		statusSpy.mockRestore();
		onStatusChangeSpy.mockRestore();
		subscribeStatusSpy.mockRestore();
		requestIssueChatSpy.mockRestore();
		abortIssueChatSpy.mockRestore();
		steerIssueChatSpy.mockRestore();
	});

	it("uses the websocket transport and streams thinking chunks while connected", async () => {
		const onThinking = vi.fn();
		statusSpy.mockReturnValue("open");
		requestIssueChatSpy.mockImplementation(async (
			_requestId: string,
			_payload: IssueChatPayload,
			onProgress?: (event: IssueChatProgressEvent) => void,
		) => {
			onProgress?.({ type: "started", message: "Starting" });
			onProgress?.({ type: "thinking", message: "Thinking", text: "step one", done: false });
			onProgress?.({ type: "thinking", message: "message fallback" });
			onProgress?.({ type: "thinking", message: "Done", text: "final thought", done: true });
			return response;
		});
		const { result } = renderHook(() => useIssueChatTransport());

		let chatResponse: IssueChatResponse | undefined;
		await act(async () => {
			chatResponse = await result.current.submitIssueChat(payload, onThinking);
		});

		expect(chatResponse).toEqual(response);
		expect(requestIssueChatSpy).toHaveBeenCalledWith(expect.stringMatching(/^issue-chat-/), payload, expect.any(Function));
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(onThinking).toHaveBeenCalledWith({ text: "step one", done: false });
		expect(onThinking).toHaveBeenCalledWith({ text: "message fallback", done: false });
		expect(onThinking).toHaveBeenCalledWith({ text: "final thought", done: true });
		expect(result.current.progressMessage).toBeNull();
	});

	it("falls back to HTTP when websocket submission fails before progress", async () => {
		const onThinking = vi.fn();
		statusSpy.mockReturnValue("open");
		requestIssueChatSpy.mockRejectedValue(new Error("socket down"));
		fetchSpy.mockResolvedValue(mockJsonResponse(response));
		const { result } = renderHook(() => useIssueChatTransport());

		let chatResponse: IssueChatResponse | undefined;
		await act(async () => {
			chatResponse = await result.current.submitIssueChat(payload, onThinking);
		});

		expect(chatResponse).toEqual(response);
		expect(fetchSpy).toHaveBeenCalledWith("/api/issues/chat", {
			body: JSON.stringify(payload),
			headers: { "Content-Type": "application/json" },
			method: "POST",
		});
		expect(onThinking).not.toHaveBeenCalled();
		expect(result.current.progressMessage).toBe("Live connection failed. Retrying over HTTP...");
	});

	it("does not fall back when websocket fails after progress starts", async () => {
		const onThinking = vi.fn();
		statusSpy.mockReturnValue("open");
		requestIssueChatSpy.mockImplementation(async (
			_requestId: string,
			_payload: IssueChatPayload,
			onProgress?: (event: IssueChatProgressEvent) => void,
		) => {
			onProgress?.({ type: "started", message: "Starting" });
			throw new Error("socket interrupted");
		});
		const { result } = renderHook(() => useIssueChatTransport());

		await act(async () => {
			await expect(result.current.submitIssueChat(payload, onThinking)).rejects.toThrow("socket interrupted");
		});

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(result.current.progressMessage).toBe("Starting");
	});

	it("uses HTTP directly when websocket is not open", async () => {
		const onThinking = vi.fn();
		statusSpy.mockReturnValue("closed");
		fetchSpy.mockResolvedValue(mockJsonResponse(response));
		const { result } = renderHook(() => useIssueChatTransport());

		let chatResponse: IssueChatResponse | undefined;
		await act(async () => {
			chatResponse = await result.current.submitIssueChat(payload, onThinking);
		});

		expect(chatResponse).toEqual(response);
		expect(requestIssueChatSpy).not.toHaveBeenCalled();
		expect(fetchSpy).toHaveBeenCalledWith("/api/issues/chat", expect.any(Object));
	});

	it("aborts the active issue chat", async () => {
		statusSpy.mockReturnValue("open");
		let resolveRequest: (value: IssueChatResponse) => void = () => {};
		requestIssueChatSpy.mockImplementation(async (_requestId: string) => {
			return new Promise((resolve) => {
				resolveRequest = resolve;
			});
		});
		const { result } = renderHook(() => useIssueChatTransport());

		// Start submit but don't await it yet
		const submitPromise = result.current.submitIssueChat(payload, vi.fn());

		// Abort while still in flight
		act(() => {
			result.current.abortIssueChat();
		});

		expect(abortIssueChatSpy).toHaveBeenCalled();

		// Resolve the pending request so the hook doesn't stay in a bad state
		resolveRequest(response);
		await submitPromise.catch(() => {});
	});

	it("steers the active issue chat", async () => {
		statusSpy.mockReturnValue("open");
		let resolveRequest: (value: IssueChatResponse) => void = () => {};
		requestIssueChatSpy.mockImplementation(async (_requestId: string) => {
			return new Promise((resolve) => {
				resolveRequest = resolve;
			});
		});
		const { result } = renderHook(() => useIssueChatTransport());

		// Start submit but don't await it yet
		const submitPromise = result.current.submitIssueChat(payload, vi.fn());

		// Steer while still in flight
		act(() => {
			result.current.steerIssueChat("focus on performance");
		});

		expect(steerIssueChatSpy).toHaveBeenCalledWith(expect.stringMatching(/^issue-chat-/), "focus on performance");

		// Resolve the pending request so the hook doesn't stay in a bad state
		resolveRequest(response);
		await submitPromise;
	});
});
