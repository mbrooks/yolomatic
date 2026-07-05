import { describe, expect, it } from "vitest";

import { createWorkerMessage } from "./protocol.js";
import { decodeWorkerWebSocketMessage, sendWorkerWebSocketMessage } from "./websocket-transport.js";

describe("worker websocket transport", () => {
	it("decodes string payloads", () => {
		const message = decodeWorkerWebSocketMessage(
			JSON.stringify(createWorkerMessage("hello", "mbrooks/tars#1", "msg-1", { workerVersion: "test", pid: 1 })) as never,
		);
		expect(message.messageId).toBe("msg-1");
	});

	it("decodes ArrayBuffer payloads", () => {
		const json = JSON.stringify(createWorkerMessage("ack", "mbrooks/tars#1", "msg-2", { ackMessageId: "msg-1" }));
		const buffer = Uint8Array.from(Buffer.from(json, "utf8")).buffer;
		const message = decodeWorkerWebSocketMessage(buffer);
		expect(message.type).toBe("ack");
	});

	it("decodes mixed binary chunk arrays", () => {
		const json = JSON.stringify(
			createWorkerMessage("error", "mbrooks/tars#1", "msg-3", {
				message: "boom",
			}),
		);
		const bytes = Buffer.from(json, "utf8");
		const chunks = [bytes.subarray(0, 10), Uint8Array.from(bytes.subarray(10))];
		const message = decodeWorkerWebSocketMessage(chunks as never);
		expect(message.type).toBe("error");
	});

	it("passes Buffer payloads through unchanged", () => {
		const raw = Buffer.from(
			JSON.stringify(createWorkerMessage("complete", "mbrooks/tars#1", "msg-4", {
				result: { status: "complete", summary: "done", rawResponse: "" },
			})),
			"utf8",
		);
		const message = decodeWorkerWebSocketMessage(raw);
		expect(message.type).toBe("complete");
	});

	it("sends serialized messages", async () => {
		const sent: string[] = [];
		const ws = {
			send(payload: string, callback: (error?: Error) => void) {
				sent.push(payload);
				callback();
			},
		};

		await sendWorkerWebSocketMessage(
			ws as never,
			createWorkerMessage("heartbeat", "mbrooks/tars#1", "msg-5", {
				state: "running",
				pid: 1,
				timestamp: new Date().toISOString(),
			}),
		);

		expect(sent).toHaveLength(1);
		expect(JSON.parse(sent[0]).messageId).toBe("msg-5");
	});

	it("rejects send failures", async () => {
		const ws = {
			send(_payload: string, callback: (error?: Error) => void) {
				callback(new Error("send failed"));
			},
		};

		await expect(
			sendWorkerWebSocketMessage(
				ws as never,
				createWorkerMessage("heartbeat", "mbrooks/tars#1", "msg-6", {
					state: "running",
					pid: 1,
					timestamp: new Date().toISOString(),
				}),
			),
		).rejects.toThrow("send failed");
	});
});
