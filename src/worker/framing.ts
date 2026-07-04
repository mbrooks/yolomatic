import type { AnyWorkerProtocolMessage, WorkerProtocolMessage } from "./protocol.js";

const LENGTH_PREFIX_BYTES = 4;

export function encodeWorkerMessage(message: WorkerProtocolMessage): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	const frame = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + body.length);
	frame.writeUInt32BE(body.length, 0);
	body.copy(frame, LENGTH_PREFIX_BYTES);
	return frame;
}

export class WorkerMessageParser {
	private buffer = Buffer.alloc(0);

	push(chunk: Buffer): AnyWorkerProtocolMessage[] {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		const messages: AnyWorkerProtocolMessage[] = [];

		while (this.buffer.length >= LENGTH_PREFIX_BYTES) {
			const length = this.buffer.readUInt32BE(0);
			if (this.buffer.length < LENGTH_PREFIX_BYTES + length) {
				break;
			}

			const json = this.buffer.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length).toString("utf8");
			this.buffer = this.buffer.subarray(LENGTH_PREFIX_BYTES + length);
			messages.push(JSON.parse(json) as AnyWorkerProtocolMessage);
		}

		return messages;
	}

	hasBufferedData(): boolean {
		return this.buffer.length > 0;
	}
}
