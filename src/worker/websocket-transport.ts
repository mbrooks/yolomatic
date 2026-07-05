import type WebSocket from "ws";
import type { RawData } from "ws";

import type { AnyWorkerProtocolMessage, WorkerProtocolMessage } from "./protocol.js";

function rawDataToBuffer(raw: RawData): Buffer {
	if (typeof raw === "string") {
		return Buffer.from(raw, "utf8");
	}
	if (raw instanceof ArrayBuffer) {
		return Buffer.from(raw);
	}
	if (Array.isArray(raw)) {
		return Buffer.concat(raw.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))));
	}
	return raw;
}

export function decodeWorkerWebSocketMessage(raw: RawData): AnyWorkerProtocolMessage {
	return JSON.parse(rawDataToBuffer(raw).toString("utf8")) as AnyWorkerProtocolMessage;
}

export function sendWorkerWebSocketMessage(
	ws: WebSocket,
	message: WorkerProtocolMessage,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		ws.send(JSON.stringify(message), (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}
