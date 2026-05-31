import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "../../../webhook/http-utils.js";
import { computeNextRunAt, type CronScheduleType } from "../../../cron/store.js";
import { sendJson } from "../response-helpers.js";
import {
	checkAdminJson,
	type AdminRouterDeps,
} from "../admin-router-shared.js";

export async function handleCronRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	pathname: string,
): Promise<boolean> {
	if (!pathname.startsWith("/api/crons/")) {
		return false;
	}
	if (!checkAdminJson(request, response, deps)) {
		return true;
	}
	if (!deps.cronStore) {
		sendJson(response, 500, { error: "Cron store not configured" });
		return true;
	}

	const listMatch = /^\/api\/crons\/([^/]+)\/([^/]+)$/u.exec(pathname);
	if (listMatch && request.method === "GET") {
		const [, owner, repo] = listMatch;
		try {
			const jobs = await deps.cronStore.listForRepo(owner, repo);
			sendJson(response, 200, { crons: jobs });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	if (listMatch && request.method === "POST") {
		const [, owner, repo] = listMatch;
		try {
			const body = JSON.parse((await readBody(request)).toString("utf8")) as {
				name?: string;
				description?: string;
				prompt?: string;
				scheduleType?: string;
				scheduleValue?: string;
				branch?: string;
				notificationChannel?: string;
			};
			if (!body.name || !body.prompt || !body.scheduleType || !body.scheduleValue) {
				sendJson(response, 400, {
					error: "Missing required fields: name, prompt, scheduleType, scheduleValue",
				});
				return true;
			}
			const job = await deps.cronStore.createJob(
				owner,
				repo,
				body.name,
				body.description || "",
				body.prompt,
				body.scheduleType as CronScheduleType,
				body.scheduleValue,
				body.branch || "main",
				body.notificationChannel || null,
			);
			sendJson(response, 201, job);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 400, { error: message });
		}
		return true;
	}

	const detailMatch = /^\/api\/crons\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(pathname);
	if (detailMatch && request.method === "GET") {
		const [, owner, repo, id] = detailMatch;
		try {
			const job = await deps.cronStore.get(owner, repo, id);
			if (!job) {
				sendJson(response, 404, { error: "Cron job not found" });
				return true;
			}
			sendJson(response, 200, job);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	if (detailMatch && request.method === "PATCH") {
		const [, owner, repo, id] = detailMatch;
		try {
			const existing = await deps.cronStore.get(owner, repo, id);
			if (!existing) {
				sendJson(response, 404, { error: "Cron job not found" });
				return true;
			}
			const body = JSON.parse((await readBody(request)).toString("utf8")) as Partial<{
				name: string;
				description: string;
				prompt: string;
				scheduleType: string;
				scheduleValue: string;
				branch: string;
				notificationChannel: string;
				enabled: boolean;
			}>;
			let shouldRecompute = false;
			if (body.name !== undefined) {
				existing.name = body.name;
			}
			if (body.description !== undefined) {
				existing.description = body.description;
			}
			if (body.prompt !== undefined) {
				existing.prompt = body.prompt;
			}
			if (body.branch !== undefined) {
				existing.branch = body.branch;
			}
			if (body.notificationChannel !== undefined) {
				existing.notificationChannel = body.notificationChannel;
			}
			if (body.scheduleType !== undefined) {
				existing.scheduleType = body.scheduleType as CronScheduleType;
				shouldRecompute = true;
			}
			if (body.scheduleValue !== undefined) {
				existing.scheduleValue = body.scheduleValue;
				shouldRecompute = true;
			}
			if (body.enabled !== undefined) {
				if (body.enabled && !existing.enabled) {
					shouldRecompute = true;
				}
				existing.enabled = body.enabled;
			}
			if (shouldRecompute) {
				existing.nextRunAt = computeNextRunAt(
					existing.scheduleType,
					existing.scheduleValue,
				);
			}
			await deps.cronStore.set(existing);
			sendJson(response, 200, existing);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 400, { error: message });
		}
		return true;
	}

	if (detailMatch && request.method === "DELETE") {
		const [, owner, repo, id] = detailMatch;
		try {
			await deps.cronStore.delete(owner, repo, id);
			sendJson(response, 200, { deleted: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	const runsMatch = /^\/api\/crons\/([^/]+)\/([^/]+)\/([^/]+)\/runs$/u.exec(pathname);
	if (runsMatch && request.method === "GET") {
		const [, owner, repo, id] = runsMatch;
		try {
			const runs = await deps.cronStore.getRuns(owner, repo, id);
			sendJson(response, 200, { runs });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	const runMatch = /^\/api\/crons\/([^/]+)\/([^/]+)\/([^/]+)\/run$/u.exec(pathname);
	if (runMatch && request.method === "POST") {
		const [, owner, repo, id] = runMatch;
		try {
			const job = await deps.cronStore.get(owner, repo, id);
			if (!job) {
				sendJson(response, 404, { error: "Cron job not found" });
				return true;
			}
			job.nextRunAt = new Date().toISOString();
			await deps.cronStore.set(job);
			sendJson(response, 200, { queued: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, 500, { error: message });
		}
		return true;
	}

	return false;
}
