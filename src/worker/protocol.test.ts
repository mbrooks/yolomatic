import { describe, expect, it } from "vitest";

import { WORKER_PROTOCOL_VERSION, createWorkerMessage } from "./protocol.js";

describe("worker protocol", () => {
	it("creates typed protocol envelopes", () => {
		const message = createWorkerMessage("complete", "mbrooks/yolomatic#418", "msg-9", {
			result: {
				status: "complete",
				summary: "done",
				rawResponse: "YOLO_STATUS: complete\ndone",
			},
		});

		expect(message).toEqual({
			type: "complete",
			protocolVersion: WORKER_PROTOCOL_VERSION,
			sessionKey: "mbrooks/yolomatic#418",
			messageId: "msg-9",
			payload: {
				result: {
					status: "complete",
					summary: "done",
					rawResponse: "YOLO_STATUS: complete\ndone",
				},
			},
		});
	});

	it("creates a tool_request envelope carrying tool name and params", () => {
		const message = createWorkerMessage("tool_request", "mbrooks/yolomatic#418", "req-1", {
			tool: "fetch_issue",
			params: { include_comments: true },
		});

		expect(message).toEqual({
			type: "tool_request",
			protocolVersion: WORKER_PROTOCOL_VERSION,
			sessionKey: "mbrooks/yolomatic#418",
			messageId: "req-1",
			payload: { tool: "fetch_issue", params: { include_comments: true } },
		});
	});

	it("creates a tool_response envelope correlating to the request by id", () => {
		const message = createWorkerMessage("tool_response", "mbrooks/yolomatic#418", "resp-1", {
			requestMessageId: "req-1",
			ok: true,
			data: { issue: { number: 418 } },
		});

		expect(message).toEqual({
			type: "tool_response",
			protocolVersion: WORKER_PROTOCOL_VERSION,
			sessionKey: "mbrooks/yolomatic#418",
			messageId: "resp-1",
			payload: { requestMessageId: "req-1", ok: true, data: { issue: { number: 418 } } },
		});
	});

	it("keeps the protocol version unchanged for the additive tool messages", () => {
		expect(WORKER_PROTOCOL_VERSION).toBe(1);
	});
});
