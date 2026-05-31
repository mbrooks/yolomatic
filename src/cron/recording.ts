import { randomUUID } from "node:crypto";
import type { CronJob, CronRun, CronStore } from "./store.js";
import { computeNextRunAt } from "./store.js";
import type { SessionState, SessionStore } from "../session/store.js";

export type CronRunStatus = "success" | "failure";

export interface CronRunRecordDeps {
	cronStore: CronStore;
	sessionStore: SessionStore;
}

export interface CronRunRecordInput {
	job: CronJob;
	state: SessionState;
	now: Date;
	status: CronRunStatus;
	output: string;
	error: string | null;
}

export async function finalizeCronSessionAndRecordRun(
	deps: CronRunRecordDeps,
	input: CronRunRecordInput,
): Promise<void> {
	const { job, state, now, status, output, error } = input;

	state.status = status === "success" ? "complete" : "failed";
	state.lastActivity = new Date().toISOString();
	if (error) {
		state.summary = error;
	} else if (output) {
		state.summary = output;
	}
	await deps.sessionStore.set(state);

	const run: CronRun = {
		id: randomUUID(),
		cronId: job.id,
		owner: job.owner,
		repo: job.repo,
		startedAt: now.toISOString(),
		finishedAt: new Date().toISOString(),
		status,
		output,
		error,
	};
	await deps.cronStore.addRun(run);

	job.lastRunAt = now.toISOString();
	job.lastRunStatus = status;
	job.lastError = error;
	job.prUrl = state.prUrl ?? job.prUrl ?? null;
	job.prNumber = state.prNumber ?? job.prNumber ?? null;
	job.nextRunAt = computeNextRunAt(job.scheduleType, job.scheduleValue, now);
	await deps.cronStore.set(job);
}
