import { describe, expect, it } from "vitest";

import { WORKER_PROTOCOL_VERSION, createWorkerMessage } from "./protocol.js";

describe("worker protocol", () => {
	it("creates typed protocol envelopes", () => {
		const message = createWorkerMessage("complete", "mbrooks/yeetomatic#418", "msg-9", {
			result: {
				status: "complete",
				summary: "done",
				rawResponse: "YEETOMATIC_STATUS: complete\ndone",
			},
		});

		expect(message).toEqual({
			type: "complete",
			protocolVersion: WORKER_PROTOCOL_VERSION,
			sessionKey: "mbrooks/yeetomatic#418",
			messageId: "msg-9",
			payload: {
				result: {
					status: "complete",
					summary: "done",
					rawResponse: "YEETOMATIC_STATUS: complete\ndone",
				},
			},
		});
	});
});
