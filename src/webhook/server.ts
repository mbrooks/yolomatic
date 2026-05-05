import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { extname, join, relative, resolve } from "node:path";

import type { WebhookHandlers } from "./handlers.js";
import type { SessionManager } from "../session/manager.js";
import type { SessionState, SessionStore } from "../session/store.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import type { StaleSessionDetector, StaleSessionInfo } from "../session/stale-detector.js";

type WebhookServerOptions = {
	adminAssetsDir?: string;
};

export interface WebhookServerDeps {
	secret: string;
	handlers: WebhookHandlers;
	sessionStore: SessionStore;
	sessionManager?: SessionManager;
	workspaceManager?: WorkspaceManager;
	staleDetector?: StaleSessionDetector;
	archiveDir?: string;
}

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

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
	response.statusCode = statusCode;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.end(JSON.stringify(body));
}

function sendText(response: ServerResponse, statusCode: number, body: string): void {
	response.statusCode = statusCode;
	response.setHeader("content-type", "text/plain; charset=utf-8");
	response.end(body);
}

function sendHtml(response: ServerResponse, statusCode: number, body: string): void {
	response.statusCode = statusCode;
	response.setHeader("content-type", "text/html; charset=utf-8");
	response.end(body);
}

function sendStream(response: ServerResponse, statusCode: number, contentType: string, path: string): void {
	response.statusCode = statusCode;
	response.setHeader("content-type", contentType);
	createReadStream(path)
		.on("error", (error) => {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[webhook] admin asset error: ${message}\n`);
			if (!response.headersSent) {
				sendText(response, 500, "Unable to read admin asset");
			} else {
				response.destroy();
			}
		})
		.pipe(response);
}

function contentTypeFor(path: string): string {
	const extension = extname(path);
	if (extension === ".css") return "text/css; charset=utf-8";
	if (extension === ".html") return "text/html; charset=utf-8";
	if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
	if (extension === ".json") return "application/json; charset=utf-8";
	if (extension === ".map") return "application/json; charset=utf-8";
	if (extension === ".svg") return "image/svg+xml";
	if (extension === ".png") return "image/png";
	if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
	if (extension === ".ico") return "image/x-icon";
	return "application/octet-stream";
}

function formatUptime(seconds: number): string {
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	const parts: string[] = [];
	if (d > 0) parts.push(`${d}d`);
	if (h > 0) parts.push(`${h}h`);
	if (m > 0) parts.push(`${m}m`);
	if (s > 0 || parts.length === 0) parts.push(`${s}s`);
	return parts.join(" ");
}

function computeAgentStatus(sessions: SessionState[]): "online" | "busy" | "feedback" {
	const hasWorking = sessions.some((s) => s.status === "working");
	if (hasWorking) return "busy";
	const hasFeedback = sessions.some((s) => s.status === "waiting-feedback");
	if (hasFeedback) return "feedback";
	return "online";
}

function buildStatusResponse(sessions: SessionState[], staleInfoMap: Map<string, StaleSessionInfo>) {
	return {
		agent: computeAgentStatus(sessions),
		uptime: formatUptime(process.uptime()),
		sessions: sessions.map((s) => {
			const stale = staleInfoMap.get(`${s.owner}/${s.repo}#${s.issueNumber}`);
			return {
				owner: s.owner,
				repo: s.repo,
				issueNumber: s.issueNumber,
				status: s.status,
				workspacePath: s.workspacePath,
				branch: `tars/issue-${s.issueNumber}`,
				lastActivity: s.lastActivity,
				prUrl: s.prUrl ?? null,
				prNumber: s.prNumber ?? null,
				staleDetectedAt: s.staleDetectedAt ?? null,
				staleReason: s.staleReason ?? null,
				stale: stale
					? {
							isStale: stale.isStale,
							ageMinutes: Math.floor(stale.ageMs / 60000),
							classification: stale.classification,
							worktreeDirty: stale.worktreeDirty,
							issueState: stale.issueState ?? null,
							prState: stale.prState ?? null,
					  }
					: null,
			};
		}),
	};
}

function fallbackAdminHtml(): string {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>TARS Admin</title>
	</head>
	<body>
		<div id="root">TARS Admin assets have not been built.</div>
	</body>
</html>`;
}

async function adminHtml(adminAssetsDir: string): Promise<string> {
	try {
		return await readFile(join(adminAssetsDir, "index.html"), "utf8");
	} catch {
		return fallbackAdminHtml();
	}
}

async function serveAdminAsset(response: ServerResponse, adminAssetsDir: string, assetPath: string): Promise<void> {
	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(assetPath);
	} catch {
		sendText(response, 400, "Invalid asset path");
		return;
	}
	const resolvedPath = resolve(adminAssetsDir, decodedPath);
	const relativePath = relative(adminAssetsDir, resolvedPath);
	if (relativePath.startsWith("..") || relativePath === "" || relativePath.startsWith("/")) {
		sendText(response, 404, "Not found");
		return;
	}

	try {
		const assetStat = await stat(resolvedPath);
		if (!assetStat.isFile()) {
			sendText(response, 404, "Not found");
			return;
		}
	} catch {
		sendText(response, 404, "Not found");
		return;
	}

	sendStream(response, 200, contentTypeFor(resolvedPath), resolvedPath);
}

function checkBasicAuth(
	request: IncomingMessage,
	response: ServerResponse,
	username: string | undefined,
	password: string | undefined,
): boolean {
	if (!username || !password) {
		return false;
	}

	const authHeader = request.headers["authorization"] as string | undefined;
	if (!authHeader || !authHeader.startsWith("Basic ")) {
		response.statusCode = 401;
		response.setHeader("WWW-Authenticate", 'Basic realm="TARS Admin"');
		response.setHeader("content-type", "text/plain; charset=utf-8");
		response.end("Unauthorized");
		return false;
	}

	const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
	const colonIndex = decoded.indexOf(":");
	const providedUser = colonIndex >= 0 ? decoded.slice(0, colonIndex) : decoded;
	const providedPass = colonIndex >= 0 ? decoded.slice(colonIndex + 1) : "";

	if (providedUser.length !== username.length || providedPass.length !== password.length) {
		response.statusCode = 401;
		response.setHeader("WWW-Authenticate", 'Basic realm="TARS Admin"');
		response.setHeader("content-type", "text/plain; charset=utf-8");
		response.end("Invalid credentials");
		return false;
	}

	const userMatch = timingSafeEqual(Buffer.from(providedUser), Buffer.from(username));
	const passMatch = timingSafeEqual(Buffer.from(providedPass), Buffer.from(password));

	if (!userMatch || !passMatch) {
		response.statusCode = 401;
		response.setHeader("WWW-Authenticate", 'Basic realm="TARS Admin"');
		response.setHeader("content-type", "text/plain; charset=utf-8");
		response.end("Invalid credentials");
		return false;
	}

	return true;
}

export function createWebhookServer(
	{ secret, handlers, sessionStore, sessionManager, workspaceManager, staleDetector, archiveDir }: WebhookServerDeps,
	adminUsername?: string,
	adminPassword?: string,
	options: WebhookServerOptions = {},
) {
	const adminAssetsDir = options.adminAssetsDir ?? resolve(process.cwd(), "dist/admin");

	return createServer(async (request, response) => {
		process.stdout.write(
			`[webhook] ${new Date().toISOString()} ${request.method ?? "UNKNOWN"} ${request.url ?? ""}\n`,
		);

		const requestUrl = new URL(request.url ?? "/", "http://localhost");

		if (request.method === "GET" && (requestUrl.pathname === "/tarsadmin" || requestUrl.pathname === "/tarsadmin/")) {
			if (!adminUsername || !adminPassword) {
				sendText(response, 404, "Not found");
				return;
			}
			if (!checkBasicAuth(request, response, adminUsername, adminPassword)) {
				return;
			}
			sendHtml(response, 200, await adminHtml(adminAssetsDir));
			return;
		}

		if (request.method === "GET" && requestUrl.pathname.startsWith("/tarsadmin/")) {
			if (!adminUsername || !adminPassword) {
				sendText(response, 404, "Not found");
				return;
			}
			if (!checkBasicAuth(request, response, adminUsername, adminPassword)) {
				return;
			}
			await serveAdminAsset(response, adminAssetsDir, requestUrl.pathname.slice("/tarsadmin/".length));
			return;
		}

		if (request.method === "GET" && requestUrl.pathname === "/api/status") {
			if (!adminUsername || !adminPassword) {
				sendJson(response, 404, { error: "Not found" });
				return;
			}
			if (!checkBasicAuth(request, response, adminUsername, adminPassword)) {
				return;
			}
			try {
				const sessions = await sessionStore.getAll();
				const staleInfoMap = new Map<string, import("../session/stale-detector.js").StaleSessionInfo>();
				if (staleDetector) {
					const staleInfos = await staleDetector.detectStaleSessions();
					for (const info of staleInfos) {
						staleInfoMap.set(
							`${info.session.owner}/${info.session.repo}#${info.session.issueNumber}`,
							info,
						);
					}
				}
				sendJson(response, 200, buildStatusResponse(sessions, staleInfoMap));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				process.stdout.write(`[webhook] status error: ${message}\n`);
				sendJson(response, 500, { error: message });
			}
			return;
		}

		if (request.method === "POST" && requestUrl.pathname === "/api/sessions/archive") {
			if (!adminUsername || !adminPassword || !sessionManager || !archiveDir) {
				sendJson(response, 404, { error: "Not found" });
				return;
			}
			if (!checkBasicAuth(request, response, adminUsername, adminPassword)) {
				return;
			}
			const body = JSON.parse((await readBody(request)).toString("utf8")) as { owner?: string; repo?: string; issueNumber?: number };
			if (!body.owner || !body.repo || !body.issueNumber) {
				sendJson(response, 400, { error: "Missing owner, repo, or issueNumber" });
				return;
			}
			try {
				await sessionManager.archiveSession(body.owner, body.repo, body.issueNumber, archiveDir);
				sendJson(response, 200, { ok: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: message });
			}
			return;
		}

		if (request.method === "POST" && requestUrl.pathname === "/api/sessions/mark-failed") {
			if (!adminUsername || !adminPassword || !sessionManager) {
				sendJson(response, 404, { error: "Not found" });
				return;
			}
			if (!checkBasicAuth(request, response, adminUsername, adminPassword)) {
				return;
			}
			const body = JSON.parse((await readBody(request)).toString("utf8")) as { owner?: string; repo?: string; issueNumber?: number; reason?: string };
			if (!body.owner || !body.repo || !body.issueNumber) {
				sendJson(response, 400, { error: "Missing owner, repo, or issueNumber" });
				return;
			}
			try {
				await sessionManager.markFailed(body.owner, body.repo, body.issueNumber, body.reason || "stale_session_cleanup");
				sendJson(response, 200, { ok: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: message });
			}
			return;
		}

		if (request.method === "POST" && requestUrl.pathname === "/api/sessions/mark-complete") {
			if (!adminUsername || !adminPassword || !sessionManager) {
				sendJson(response, 404, { error: "Not found" });
				return;
			}
			if (!checkBasicAuth(request, response, adminUsername, adminPassword)) {
				return;
			}
			const body = JSON.parse((await readBody(request)).toString("utf8")) as { owner?: string; repo?: string; issueNumber?: number };
			if (!body.owner || !body.repo || !body.issueNumber) {
				sendJson(response, 400, { error: "Missing owner, repo, or issueNumber" });
				return;
			}
			try {
				await sessionManager.markComplete(body.owner, body.repo, body.issueNumber);
				sendJson(response, 200, { ok: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: message });
			}
			return;
		}

		if (request.method === "POST" && requestUrl.pathname === "/api/sessions/prune-worktree") {
			if (!adminUsername || !adminPassword || !workspaceManager) {
				sendJson(response, 404, { error: "Not found" });
				return;
			}
			if (!checkBasicAuth(request, response, adminUsername, adminPassword)) {
				return;
			}
			const body = JSON.parse((await readBody(request)).toString("utf8")) as { owner?: string; repo?: string; issueNumber?: number; confirmDirty?: boolean };
			if (!body.owner || !body.repo || !body.issueNumber) {
				sendJson(response, 400, { error: "Missing owner, repo, or issueNumber" });
				return;
			}
			try {
				const dirty = await workspaceManager.hasChanges(
					workspaceManager["getWorktreePath"](body.owner, body.repo, body.issueNumber),
					false,
				);
				if (dirty && !body.confirmDirty) {
					sendJson(response, 409, { error: "Worktree is dirty. Pass confirmDirty=true to force." });
					return;
				}
				await workspaceManager.removeWorktree(body.owner, body.repo, body.issueNumber);
				sendJson(response, 200, { ok: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sendJson(response, 500, { error: message });
			}
			return;
		}

		if (request.method !== "POST" || request.url !== "/webhook") {
			process.stdout.write("[webhook] rejected request: route mismatch\n");
			sendText(response, 404, "Not found");
			return;
		}

		const body = await readBody(request);
		const signature = request.headers["x-hub-signature-256"] as string | undefined;

		if (!verifySignature(secret, body, signature)) {
			process.stdout.write("[webhook] rejected request: invalid signature\n");
			sendText(response, 401, "Invalid signature");
			return;
		}

		const event = request.headers["x-github-event"] as string | undefined;
		const delivery = request.headers["x-github-delivery"] as string | undefined;

		const payload = JSON.parse(body.toString("utf8")) as unknown;
		process.stdout.write(
			`[webhook] accepted delivery=${delivery ?? "unknown"} event=${event ?? "unknown"}\n`,
		);

		try {
			if (event === "issues") {
				await handlers.handleIssueEvent(payload);
			} else if (event === "issue_comment") {
				await handlers.handleCommentEvent(payload);
			} else if (event === "pull_request_review_comment") {
				await handlers.handlePullRequestReviewCommentEvent(payload);
			} else if (event === "pull_request_review") {
				await handlers.handlePullRequestReviewEvent(payload);
			} else {
				process.stdout.write(`[webhook] ignored unsupported event=${event ?? "unknown"}\n`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[webhook] handler error: ${message}\n`);
			sendText(response, 500, message);
			return;
		}

		process.stdout.write("[webhook] handled successfully\n");
		sendText(response, 200, "OK");
	});
}
