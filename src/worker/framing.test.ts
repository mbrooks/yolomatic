import { describe, expect, it } from "vitest";

import { WorkerMessageParser, encodeWorkerMessage } from "./framing.js";
import { createWorkerMessage } from "./protocol.js";

describe("worker framing", () => {
	it("round-trips framed protocol messages", () => {
		const message = createWorkerMessage("hello", "mbrooks/tars#418", "msg-1", {
			workerVersion: "1.0.0",
			pid: 42,
		});

		const encoded = encodeWorkerMessage(message);
		const parser = new WorkerMessageParser();

		expect(parser.push(encoded)).toEqual([message]);
		expect(parser.hasBufferedData()).toBe(false);
	});

	it("supports incremental chunk parsing", () => {
		const message = createWorkerMessage("heartbeat", "mbrooks/tars#418", "msg-2", {
			state: "running",
			pid: 42,
			timestamp: "2026-07-03T19:21:00.000Z",
		});

		const encoded = encodeWorkerMessage(message);
		const parser = new WorkerMessageParser();

		expect(parser.push(encoded.subarray(0, 3))).toEqual([]);
		expect(parser.hasBufferedData()).toBe(true);
		expect(parser.push(encoded.subarray(3))).toEqual([message]);
	});
});
