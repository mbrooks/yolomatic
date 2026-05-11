import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { extname, join, relative, resolve } from "node:path";

import type { WebhookHandlers } from "./handlers.js";
import { isTerminalStatus, type SessionState, type SessionStore } from "../session/store.js";
import type { TaskController } from "../task-controller.js";
import type { StaleSessionDetector, StaleSessionInfo } from "../session/stale-detector.js";
import type { WorkspaceManager } from "../workspace/manager.js";

type WebhookServerOptions = {
	adminAssetsDir?: string;
};

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

function detectSessionRisk(session: SessionState): {
	suspectedMisroute: boolean;
	reasons: string[];
	referencedIssueNumber: number | null;
} {
	const reasons: string[] = [];
	let referencedIssueNumber: number | null = null;
	const fixesMatch = /^Fixes #(\d+)/u.exec(session.body.trim());
	if (fixesMatch) {
		referencedIssueNumber = Number.parseInt(fixesMatch[1], 10);
		if (referencedIssueNumber !== session.issueNumber) {
			reasons.push(`Session body references issue #${referencedIssueNumber}.`);
		}
	}

	if (session.title.trim().startsWith("TARS:")) {
		reasons.push("Session title looks like a generated PR title.");
	}

	if (!session.workspacePath.endsWith(`issue-${session.issueNumber}`)) {
		reasons.push(`Workspace path does not end with issue-${session.issueNumber}.`);
	}

	return {
		suspectedMisroute: reasons.length > 0,
		reasons,
		referencedIssueNumber,
	};
}

function buildRepoSummaries(sessions: SessionState[]): Array<{ owner: string; repo: string; sessionCount: number; activeCount: number }> {
	const map = new Map<string, { owner: string; repo: string; sessionCount: number; activeCount: number }>();
	for (const s of sessions) {
		const key = `${s.owner}/${s.repo}`;
		const existing = map.get(key);
		if (existing) {
			existing.sessionCount++;
			if (!isTerminalStatus(s.status)) existing.activeCount++;
		} else {
			map.set(key, {
				owner: s.owner,
				repo: s.repo,
				sessionCount: 1,
				activeCount: isTerminalStatus(s.status) ? 0 : 1,
			});
		}
	}
	return Array.from(map.values()).sort((a, b) => {
		if (a.owner !== b.owner) return a.owner.localeCompare(b.owner);
		return a.repo.localeCompare(b.repo);
	});
}

function buildStatusResponse(sessions: SessionState[], staleInfoMap?: Map<string, StaleSessionInfo>) {
	const sorted = [...sessions].sort((a, b) => {
		const aTime = a.createdAt ?? a.lastActivity;
		const bTime = b.createdAt ?? b.lastActivity;
		return new Date(bTime).getTime() - new Date(aTime).getTime();
	});
	return {
		agent: computeAgentStatus(sorted),
		uptime: formatUptime(process.uptime()),
		repos: buildRepoSummaries(sorted),
		sessions: sorted.map((s) => {
			const stale = staleInfoMap?.get(`${s.owner}/${s.repo}#${s.issueNumber}`);
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
				risk: detectSessionRisk(s),
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
	secret: string,
	handlers: WebhookHandlers,
	sessionStore: SessionStore,
	adminUsername?: string,
	adminPassword?: string,
	taskController?: TaskController,
	workspaceManager?: WorkspaceManager,
	staleDetector?: StaleSessionDetector,
	archiveDir?: string,
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
				const staleInfoMap = new Map<string, StaleSessionInfo>();
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

		if (request.method === "GET" && requestUrl.pathname.startsWith("/api/sessions/")) {
			if (!adminUsername || !adminPassword) {
				sendJson(response, 404, { error: "Not found" });
				return;
			}
			if (!checkBasicAuth(request, response, adminUsername, adminPassword)) {
				return;
			}

			const logMatch = /^\/api\/sessions\/([^/]+)\/([^/]+)\/(\d+)\/log$/u.exec(requestUrl.pathname);
			if (logMatch) {
				const [, owner, repo, issueNumberStr] = logMatch;
				const issueNumber = Number.parseInt(issueNumberStr, 10);
				if (Number.isNaN(issueNumber)) {
					sendJson(response, 400, { error: "Invalid issue number" });
					return;
				}

				try {
					const session = await sessionStore.get(owner, repo, issueNumber);
					if (!session) {
						sendJson(response, 404, { error: "Session not found" });
						return;
					}

					if (!session.sessionPath) {
						sendJson(response, 200, { available: false, error: "No session log path configured" });
						return;
					}

					let raw: string;
					try {
						raw = await readFile(session.sessionPath, "utf8");
					} catch {
						sendJson(response, 200, { available: false, error: "Log file not found" });
						return;
					}

					const allLines = raw.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
					const MAX_LINES = 10_000;
					const truncated = allLines.length > MAX_LINES;
					const lines = truncated ? allLines.slice(allLines.length - MAX_LINES) : allLines;

					sendJson(response, 200, {
						available: true,
						truncated,
						totalLines: allLines.length,
						lines,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(`[webhook] log error: ${message}\n`);
					sendJson(response, 500, { error: message });
				}
				return;
			}

			sendJson(response, 404, { error: "Not found" });
			return;
		}

		if (request.method === "POST" && requestUrl.pathname.startsWith("/api/sessions/")) {
			if (!adminUsername || !adminPassword) {
				sendJson(response, 404, { error: "Not found" });
				return;
			}
			if (!checkBasicAuth(request, response, adminUsername, adminPassword)) {
				return;
			}

			const cancelMatch = /^\/api\/sessions\/([^/]+)\/([^/]+)\/(\d+)\/cancel$/u.exec(requestUrl.pathname);
			if (cancelMatch) {
				const [, owner, repo, issueNumberStr] = cancelMatch;
				const issueNumber = Number.parseInt(issueNumberStr, 10);
				if (Number.isNaN(issueNumber)) {
					sendJson(response, 400, { error: "Invalid issue number" });
					return;
				}

				try {
					const session = await sessionStore.get(owner, repo, issueNumber);
					if (!session) {
						sendJson(response, 404, { error: "Session not found" });
						return;
					}

					const key = `${owner}/${repo}#${issueNumber}`;
					const wasActive = taskController?.isActive(key) ?? false;
					const cancelled = taskController?.cancel(key) ?? false;

					if (cancelled) {
						sendJson(response, 200, {
							owner,
							repo,
							issueNumber,
							cancelled: true,
							wasActive,
							message: "Cancellation signal sent. TARS will stop after completing the current step.",
						});
					} else {
						if (session.status === "working") {
							session.status = "cancelled";
							session.lastActivity = new Date().toISOString();
							await sessionStore.set(session);
						}
						sendJson(response, 200, {
							owner,
							repo,
							issueNumber,
							cancelled: false,
							wasActive,
							status: session.status,
							message: session.status === "cancelled" ? "Session marked as cancelled." : "TARS was not active on this session.",
						});
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(`[webhook] cancel error: ${message}\n`);
					sendJson(response, 500, { error: message });
				}
				return;
			}

			const restartMatch = /^\/api\/sessions\/([^/]+)\/([^/]+)\/(\d+)\/restart$/u.exec(requestUrl.pathname);
			if (restartMatch) {
				const [, owner, repo, issueNumberStr] = restartMatch;
				const issueNumber = Number.parseInt(issueNumberStr, 10);
				if (Number.isNaN(issueNumber)) {
					sendJson(response, 400, { error: "Invalid issue number" });
					return;
				}

				try {
					const session = await sessionStore.get(owner, repo, issueNumber);
					if (!session) {
						sendJson(response, 404, { error: "Session not found" });
						return;
					}

					if (session.status === "complete") {
						sendJson(response, 400, {
							error: `Cannot restart a completed session.`,
						});
						return;
					}

					if (!isTerminalStatus(session.status)) {
						sendJson(response, 400, {
							error: `Cannot restart session in '${session.status}' status. Only failed or cancelled sessions can be restarted.`,
						});
						return;
					}

					if (workspaceManager) {
						await workspaceManager.removeWorktree(owner, repo, issueNumber);
					}

					const originalStatus = session.status;
					session.status = "pending";
					session.summary = undefined;
					session.prUrl = undefined;
					session.prNumber = undefined;
					session.seeded = false;
					session.iterationCount = undefined;
					session.restartCount = (session.restartCount ?? 0) + 1;
					session.restartedFrom = originalStatus;
					session.lastActivity = new Date().toISOString();
					await sessionStore.set(session);

					sendJson(response, 200, {
						owner,
						repo,
						issueNumber,
						restarted: true,
						status: "pending",
						message: "Session restarted. Workspace reset to fresh state. TARS will re-process on the next triggering event.",
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(`[webhook] restart error: ${message}\n`);
					sendJson(response, 500, { error: message });
				}
				return;
			}

			const deleteMatch = /^\/api\/sessions\/([^/]+)\/([^/]+)\/(\d+)\/delete$/u.exec(requestUrl.pathname);
			if (deleteMatch) {
				const [, owner, repo, issueNumberStr] = deleteMatch;
				const issueNumber = Number.parseInt(issueNumberStr, 10);
				if (Number.isNaN(issueNumber)) {
					sendJson(response, 400, { error: "Invalid issue number" });
					return;
				}

				try {
					const session = await sessionStore.get(owner, repo, issueNumber);
					if (!session) {
						sendJson(response, 404, { error: "Session not found" });
						return;
					}

					if (!isTerminalStatus(session.status)) {
						sendJson(response, 400, {
							error: `Cannot delete session in '${session.status}' status. Only terminal sessions (complete, failed, cancelled) can be deleted.`,
						});
						return;
					}

					if (workspaceManager) {
						await workspaceManager.removeWorktree(owner, repo, issueNumber);
					}
					await sessionStore.delete(owner, repo, issueNumber);

					sendJson(response, 200, {
						owner,
						repo,
						issueNumber,
						deleted: true,
						message: "Session and workspace deleted.",
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(`[webhook] delete error: ${message}\n`);
					sendJson(response, 500, { error: message });
				}
				return;
			}

			const markFailedMatch = /^\/api\/sessions\/([^/]+)\/([^/]+)\/(\d+)\/mark-failed$/u.exec(requestUrl.pathname);
			if (markFailedMatch) {
				const [, owner, repo, issueNumberStr] = markFailedMatch;
				const issueNumber = Number.parseInt(issueNumberStr, 10);
				if (Number.isNaN(issueNumber)) {
					sendJson(response, 400, { error: "Invalid issue number" });
					return;
				}

				try {
					const session = await sessionStore.get(owner, repo, issueNumber);
					if (!session) {
						sendJson(response, 404, { error: "Session not found" });
						return;
					}

					session.status = "failed";
					session.summary = "Marked failed by admin cleanup.";
					session.lastActivity = new Date().toISOString();
					await sessionStore.set(session);

					sendJson(response, 200, {
						owner,
						repo,
						issueNumber,
						status: session.status,
						message: "Session marked as failed.",
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(`[webhook] mark failed error: ${message}\n`);
					sendJson(response, 500, { error: message });
				}
				return;
			}

			const archiveMatch = /^\/api\/sessions\/([^/]+)\/([^/]+)\/(\d+)\/archive$/u.exec(requestUrl.pathname);
			if (archiveMatch) {
				const [, owner, repo, issueNumberStr] = archiveMatch;
				const issueNumber = Number.parseInt(issueNumberStr, 10);
				if (Number.isNaN(issueNumber)) {
					sendJson(response, 400, { error: "Invalid issue number" });
					return;
				}

				try {
					const session = await sessionStore.get(owner, repo, issueNumber);
					if (!session) {
						sendJson(response, 404, { error: "Session not found" });
						return;
					}

					if (!archiveDir) {
						sendJson(response, 500, { error: "Archive directory not configured" });
						return;
					}

					session.archivedAt = new Date().toISOString();
					await sessionStore.set(session);
					await sessionStore.archive(session, archiveDir);

					sendJson(response, 200, {
						owner,
						repo,
						issueNumber,
						archived: true,
						message: "Session archived.",
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(`[webhook] archive error: ${message}\n`);
					sendJson(response, 500, { error: message });
				}
				return;
			}

			const markCompleteMatch = /^\/api\/sessions\/([^/]+)\/([^/]+)\/(\d+)\/mark-complete$/u.exec(requestUrl.pathname);
			if (markCompleteMatch) {
				const [, owner, repo, issueNumberStr] = markCompleteMatch;
				const issueNumber = Number.parseInt(issueNumberStr, 10);
				if (Number.isNaN(issueNumber)) {
					sendJson(response, 400, { error: "Invalid issue number" });
					return;
				}

				try {
					const session = await sessionStore.get(owner, repo, issueNumber);
					if (!session) {
						sendJson(response, 404, { error: "Session not found" });
						return;
					}

					session.status = "complete";
					session.lastActivity = new Date().toISOString();
					await sessionStore.set(session);

					sendJson(response, 200, {
						owner,
						repo,
						issueNumber,
						status: session.status,
						message: "Session marked as complete.",
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(`[webhook] mark-complete error: ${message}\n`);
					sendJson(response, 500, { error: message });
				}
				return;
			}

			const pruneWorktreeMatch = /^\/api\/sessions\/([^/]+)\/([^/]+)\/(\d+)\/prune-worktree$/u.exec(requestUrl.pathname);
			if (pruneWorktreeMatch) {
				const [, owner, repo, issueNumberStr] = pruneWorktreeMatch;
				const issueNumber = Number.parseInt(issueNumberStr, 10);
				if (Number.isNaN(issueNumber)) {
					sendJson(response, 400, { error: "Invalid issue number" });
					return;
				}

				try {
					if (!workspaceManager) {
						sendJson(response, 500, { error: "Workspace manager not configured" });
						return;
					}

					const requestBody = JSON.parse((await readBody(request)).toString("utf8")) as { confirmDirty?: boolean };
					const worktreePath = workspaceManager["getWorktreePath"](owner, repo, issueNumber);
					const dirty = await workspaceManager.hasChanges(worktreePath, false);
					if (dirty && !requestBody.confirmDirty) {
						sendJson(response, 409, { error: "Worktree is dirty. Pass confirmDirty=true to force." });
						return;
					}

					await workspaceManager.removeWorktree(owner, repo, issueNumber);

					sendJson(response, 200, {
						owner,
						repo,
						issueNumber,
						pruned: true,
						message: "Worktree pruned.",
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					process.stdout.write(`[webhook] prune-worktree error: ${message}\n`);
					sendJson(response, 500, { error: message });
				}
				return;
			}

			sendJson(response, 404, { error: "Not found" });
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

export async function cleanupOldSessions(
	sessionStore: SessionStore,
	workspaceManager: WorkspaceManager | undefined,
	retentionDays: number,
): Promise<{ deleted: number; failed: number }> {
	const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	const sessions = await sessionStore.getAll();
	const stale = sessions.filter((s) => isTerminalStatus(s.status) && new Date(s.lastActivity).getTime() < cutoff);
	let deleted = 0;
	let failed = 0;
	for (const session of stale) {
		try {
			if (workspaceManager) {
				await workspaceManager.removeWorktree(session.owner, session.repo, session.issueNumber);
			}
			await sessionStore.delete(session.owner, session.repo, session.issueNumber);
			deleted++;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[cleanup] failed to delete ${session.owner}/${session.repo}#${session.issueNumber}: ${message}\n`);
			failed++;
		}
	}
	if (deleted > 0 || failed > 0) {
		process.stdout.write(`[cleanup] ${deleted} deleted, ${failed} failed out of ${stale.length} stale sessions\n`);
	}
	return { deleted, failed };
}
