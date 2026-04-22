import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import type { WebhookHandlers } from "./handlers.js";

async function readBody(request: IncomingMessage): Promise<Buffer> {
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

function json(response: ServerResponse, statusCode: number, body: string): void {
	response.statusCode = statusCode;
	response.setHeader("content-type", "text/plain; charset=utf-8");
	response.end(body);
}

export function createWebhookServer(secret: string, handlers: WebhookHandlers) {
	return createServer(async (request, response) => {
		process.stdout.write(
			`[webhook] ${new Date().toISOString()} ${request.method ?? "UNKNOWN"} ${request.url ?? ""}\n`,
		);

		if (request.method !== "POST" || request.url !== "/webhook") {
			process.stdout.write("[webhook] rejected request: route mismatch\n");
			json(response, 404, "Not found");
			return;
		}

		const body = await readBody(request);
		const signature = Array.isArray(request.headers["x-hub-signature-256"])
			? request.headers["x-hub-signature-256"][0]
			: request.headers["x-hub-signature-256"];

		if (!verifySignature(secret, body, signature)) {
			process.stdout.write("[webhook] rejected request: invalid signature\n");
			json(response, 401, "Invalid signature");
			return;
		}

		const event = Array.isArray(request.headers["x-github-event"])
			? request.headers["x-github-event"][0]
			: request.headers["x-github-event"];
		const delivery = Array.isArray(request.headers["x-github-delivery"])
			? request.headers["x-github-delivery"][0]
			: request.headers["x-github-delivery"];

		const payload = JSON.parse(body.toString("utf8")) as unknown;
		process.stdout.write(
			`[webhook] accepted delivery=${delivery ?? "unknown"} event=${event ?? "unknown"}\n`,
		);

		try {
			if (event === "issues") {
				await handlers.handleIssueEvent(payload);
			} else if (event === "issue_comment") {
				await handlers.handleCommentEvent(payload);
			} else {
				process.stdout.write(`[webhook] ignored unsupported event=${event ?? "unknown"}\n`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[webhook] handler error: ${message}\n`);
			json(response, 500, message);
			return;
		}

		process.stdout.write("[webhook] handled successfully\n");
		json(response, 200, "OK");
	});
}
