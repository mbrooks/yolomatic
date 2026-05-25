import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export async function readBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

export function verifySignature(secret: string, payload: Buffer, signatureHeader: string | undefined): boolean {
	if (!signatureHeader) {
		return false;
	}
	const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
	const actual = Buffer.from(signatureHeader);
	const target = Buffer.from(expected);
	if (actual.length !== target.length) {
		return false;
	}
	return timingSafeEqual(actual, target);
}
