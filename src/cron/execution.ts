import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { CronJob } from "./store.js";
import { buildCronPrompt } from "./session.js";
import type { PiAgentExecutor, ExecutionResult } from "../executor/index.js";
import type { SessionState } from "../session/store.js";
import type { WorkspaceManager } from "../workspace/manager.js";

export interface CronExecutionDeps {
	workspaceManager: WorkspaceManager;
	executor: PiAgentExecutor;
}

export async function runCronExecution(
	deps: CronExecutionDeps,
	job: CronJob,
	state: SessionState,
	sessionPath: string,
): Promise<ExecutionResult> {
	await deps.workspaceManager.createOrResetCronWorktree(
		job.owner,
		job.repo,
		job.id,
		job.branch || "main",
	);

	await mkdir(path.dirname(sessionPath), { recursive: true });

	return deps.executor.executeWithOverride(
		state,
		buildCronPrompt(job),
	);
}
