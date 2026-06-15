import type { IncomingMessage, ServerResponse } from "node:http";
import { computeNextRunAt, type CronScheduleType } from "../../../cron/store.js";
import { sendJson } from "../response-helpers.js";
import {
	AdminRouteRegistry,
	NotFoundError,
	type AdminRouterDeps,
} from "../admin-router-shared.js";

const registry = new AdminRouteRegistry()
	.route<{
		name?: string;
		description?: string;
		prompt?: string;
		scheduleType?: string;
		scheduleValue?: string;
		branch?: string;
		notificationChannel?: string;
	}>({
		method: "POST",
		pattern: /^\/api\/crons\/([^/]+)\/([^/]+)$/u,
		parseBody: true,
		required: ["name", "prompt", "scheduleType", "scheduleValue"],
		handler: async (ctx) => {
			const [owner, repo] = ctx.params;
			const body = ctx.body as {
				name: string;
				description?: string;
				prompt: string;
				scheduleType: string;
				scheduleValue: string;
				branch?: string;
				notificationChannel?: string;
			};
			if (!ctx.deps.cronStore) {
				sendJson(ctx.response, 500, { error: "Cron store not configured" });
				return;
			}
			const job = await ctx.deps.cronStore.createJob(
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
			return { status: 201, body: job };
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/crons\/([^/]+)\/([^/]+)$/u,
		handler: async (ctx) => {
			const [owner, repo] = ctx.params;
			if (!ctx.deps.cronStore) {
				sendJson(ctx.response, 500, { error: "Cron store not configured" });
				return;
			}
			const jobs = await ctx.deps.cronStore.listForRepo(owner, repo);
			return { status: 200, body: { crons: jobs } };
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/crons\/([^/]+)\/([^/]+)\/([^/]+)$/u,
		handler: async (ctx) => {
			const [owner, repo, id] = ctx.params;
			if (!ctx.deps.cronStore) {
				sendJson(ctx.response, 500, { error: "Cron store not configured" });
				return;
			}
			const job = await ctx.deps.cronStore.get(owner, repo, id);
			if (!job) {
				throw new NotFoundError("Cron job not found");
			}
			return { status: 200, body: job };
		},
	})
	.route<Partial<{
		name: string;
		description: string;
		prompt: string;
		scheduleType: string;
		scheduleValue: string;
		branch: string;
		notificationChannel: string;
		enabled: boolean;
	}>>({
		method: "PATCH",
		pattern: /^\/api\/crons\/([^/]+)\/([^/]+)\/([^/]+)$/u,
		parseBody: true,
		handler: async (ctx) => {
			const [owner, repo, id] = ctx.params;
			if (!ctx.deps.cronStore) {
				sendJson(ctx.response, 500, { error: "Cron store not configured" });
				return;
			}
			const existing = await ctx.deps.cronStore.get(owner, repo, id);
			if (!existing) {
				throw new NotFoundError("Cron job not found");
			}
			const body = ctx.body as Partial<{
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
				existing.nextRunAt = computeNextRunAt(existing.scheduleType, existing.scheduleValue);
			}
			await ctx.deps.cronStore.set(existing);
			return { status: 200, body: existing };
		},
	})
	.route({
		method: "DELETE",
		pattern: /^\/api\/crons\/([^/]+)\/([^/]+)\/([^/]+)$/u,
		handler: async (ctx) => {
			const [owner, repo, id] = ctx.params;
			if (!ctx.deps.cronStore) {
				sendJson(ctx.response, 500, { error: "Cron store not configured" });
				return;
			}
			await ctx.deps.cronStore.delete(owner, repo, id);
			return { status: 200, body: { deleted: true } };
		},
	})
	.route({
		method: "GET",
		pattern: /^\/api\/crons\/([^/]+)\/([^/]+)\/([^/]+)\/runs$/u,
		handler: async (ctx) => {
			const [owner, repo, id] = ctx.params;
			if (!ctx.deps.cronStore) {
				sendJson(ctx.response, 500, { error: "Cron store not configured" });
				return;
			}
			const runs = await ctx.deps.cronStore.getRuns(owner, repo, id);
			return { status: 200, body: { runs } };
		},
	})
	.route({
		method: "POST",
		pattern: /^\/api\/crons\/([^/]+)\/([^/]+)\/([^/]+)\/run$/u,
		handler: async (ctx) => {
			const [owner, repo, id] = ctx.params;
			if (!ctx.deps.cronStore) {
				sendJson(ctx.response, 500, { error: "Cron store not configured" });
				return;
			}
			const job = await ctx.deps.cronStore.get(owner, repo, id);
			if (!job) {
				throw new NotFoundError("Cron job not found");
			}
			job.nextRunAt = new Date().toISOString();
			await ctx.deps.cronStore.set(job);
			return { status: 200, body: { queued: true } };
		},
	});

export async function handleCronRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	pathname: string,
): Promise<boolean> {
	if (!pathname.startsWith("/api/crons/")) {
		return false;
	}
	return registry.handle(request, response, deps, pathname);
}
