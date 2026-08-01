import type { GitHubService } from "../../ports/github-service.js";
import type { TaskControlService } from "../../ports/task-control-service.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { Clock } from "../../ports/clock.js";
import type { DockerWorkerExecutor } from "../../executor/docker-worker.js";
import type { RefinementStore } from "../../refinement/store.js";
import { fingerprintBody } from "../../refinement/fingerprint.js";
import { issueSessionKey } from "./workflow-helpers.js";
import { isAdmin, isAdminPermission, isIssueRefinementCommand } from "../../domain/workflow/policy.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { statSync } from "node:fs";

export interface IssueRefinementEventPayload {
	action: string;
	issue: {
		number: number;
		state?: string;
		title?: string;
		body?: string | null;
		pull_request?: { url: string };
		labels?: Array<{ name?: string }>;
		assignee?: { login: string } | null;
		assignees?: { login: string }[];
		user?: { login: string };
	};
	comment: { id?: number; body: string; user: { login: string; type?: string } };
	repository: { name: string; owner: { login: string } };
	sender: { login: string };
}

export interface IssueRefinementInstructionPayload {
	action: string;
	issue: {
		number: number;
		title: string;
		body: string | null;
		labels?: Array<{ name?: string }>;
		assignee?: { login: string } | null;
		assignees?: { login: string }[];
		user?: { login: string };
	};
	repository: { name: string; owner: { login: string } };
	sender: { login: string };
}

export const ISSUE_REFINEMENT_INSTRUCTIONS = [
	"## Yeetomatic issue refinement",
	"",
	"An authorized maintainer can ask Yeetomatic to investigate this issue and replace its body with a more complete Proposed Task. Yeetomatic uses this repository's `issue-refinement` skill when available, otherwise it uses its built-in issue-refinement defaults.",
	"",
	"To start, comment:",
	"",
	"/yeetomatic issue-refinement",
	"",
	"The command starts an LLM-driven worker with repository, shell, test, and network access. Because issue content can influence the worker's behavior, verify the issue before starting refinement.",
	"",
	"When refinement succeeds, Yeetomatic automatically replaces this issue body. The original body is retained in Yeetomatic's refinement history. Refinement does not start implementation or create a pull request.",
].join("\n");

export class HandleIssueRefinement {
	private readonly inFlight = new Set<string>();

	constructor(
		private readonly deps: {
			refinementStore: RefinementStore;
			github: GitHubService;
			tasks: TaskControlService;
			workspaces: WorkspaceService;
			executor: DockerWorkerExecutor;
			clock: Clock;
			adminGithubUsername?: string;
			githubUsername: string;
			defaultBranch?: string;
			resolveDefaultBranch?: (owner: string, repo: string) => string;
			isRepoManaged?: (owner: string, repo: string) => boolean;
			refinementEnabled?: boolean;
		},
	) {}

	isInFlight(owner: string, repo: string, issueNumber: number): boolean {
		return this.inFlight.has(issueSessionKey(owner, repo, issueNumber));
	}

	async postInstructions(payload: IssueRefinementInstructionPayload): Promise<void> {
		const { owner, repo, issueNumber } = this.resolveContext(payload);
		const issue = payload.issue;

		if (!this.isEligibleForInstructions(payload)) {
			return;
		}

		const existing = this.deps.refinementStore.getInstructionComment(owner, repo, issueNumber);
		if (existing) {
			process.stdout.write(`[refinement] instructions already recorded for ${owner}/${repo}#${issueNumber}\n`);
			return;
		}

		process.stdout.write(`[refinement] posting instructions for ${owner}/${repo}#${issueNumber}\n`);
		const commentId = await this.deps.github.postComment(owner, repo, issueNumber, ISSUE_REFINEMENT_INSTRUCTIONS);
		this.deps.refinementStore.recordInstructionComment(owner, repo, issueNumber, commentId);
	}

	async execute(payload: IssueRefinementEventPayload): Promise<void> {
		const { owner, repo, issueNumber, key } = this.resolveContext(payload);

		if (payload.action !== "created") {
			process.stdout.write(`[refinement] ignored: action is ${payload.action}\n`);
			return;
		}

		if (!isIssueRefinementCommand(payload.comment.body)) {
			return;
		}

		process.stdout.write(`[refinement] command received for ${owner}/${repo}#${issueNumber}\n`);

		if (payload.comment.user.login === this.deps.githubUsername) {
			process.stdout.write(`[refinement] ignored: comment from ${this.deps.githubUsername}\n`);
			return;
		}

		if (payload.comment.user.type === "Bot") {
			process.stdout.write(`[refinement] ignored: bot comment\n`);
			return;
		}

		if (payload.issue.pull_request) {
			process.stdout.write(`[refinement] ignored: comment is on a pull request\n`);
			return;
		}

		if (payload.issue.state === "closed") {
			process.stdout.write(`[refinement] ignored: issue is closed\n`);
			return;
		}

		if (this.deps.isRepoManaged && !this.deps.isRepoManaged(owner, repo)) {
			process.stdout.write(`[refinement] ignored: repository not managed\n`);
			return;
		}

		if (this.deps.refinementEnabled === false) {
			process.stdout.write(`[refinement] ignored: refinement disabled\n`);
			return;
		}

		const authorized =
			isAdmin(payload.sender.login, this.deps.adminGithubUsername) ||
			isAdminPermission(await this.deps.github.getCollaboratorPermissionLevel(owner, repo, payload.sender.login));
		if (!authorized) {
			process.stdout.write(`[refinement] ignored: ${payload.sender.login} is not a repository owner\n`);
			await this.deps.github.postComment(owner, repo, issueNumber, "Only repository owners can run issue refinement.");
			return;
		}

		if (this.inFlight.has(key)) {
			process.stdout.write(`[refinement] ignored: ${key} is already being refined\n`);
			await this.deps.github.postComment(owner, repo, issueNumber, "Refinement is already running for this issue.");
			return;
		}

		if (this.deps.tasks.isActive(key)) {
			process.stdout.write(`[refinement] ignored: ${key} has an active implementation task\n`);
			await this.deps.github.postComment(owner, repo, issueNumber, "Yeetomatic is currently working on this issue. Refinement cannot overlap with implementation.");
			return;
		}

		this.inFlight.add(key);
		const registration = this.deps.tasks.register(
			key,
			() => {},
			async () => {},
		);
		if (registration === null) {
			this.inFlight.delete(key);
			process.stdout.write(`[refinement] ignored: ${key} task key is already claimed\n`);
			await this.deps.github.postComment(owner, repo, issueNumber, "Yeetomatic is currently active on this issue. Refinement cannot overlap with implementation.");
			return;
		}

		let attemptId: string | undefined;
		let worktreePath: string | undefined;

		try {
			const issue = await this.deps.github.getIssue(owner, repo, issueNumber);
			if (!issue || issue.state === "closed") {
				process.stdout.write(`[refinement] ignored: issue is no longer open\n`);
				return;
			}

			const title = payload.issue.title ?? "";
			const body = payload.issue.body ?? "";
			const fingerprint = fingerprintBody(body);

			attemptId = this.deps.refinementStore.createAttempt({
				owner,
				repo,
				issueNumber,
				commandCommentId: payload.comment.id,
				requester: payload.sender.login,
				originalTitle: title,
				originalBody: body,
				originalBodyFingerprint: fingerprint,
				instructionSource: "prompt-defaults",
				state: "running",
			}).id;

			worktreePath = await this.deps.workspaces.createRefinementWorktree!(owner, repo, issueNumber);

			const skillInfo = await this.resolveSkill(owner, repo, worktreePath);
			this.deps.refinementStore.updateAttempt(attemptId, {
				instructionSource: skillInfo.source,
				repoCommit: skillInfo.commit,
			});

			const state = this.buildSessionState(owner, repo, issueNumber, title, body, worktreePath);
			const result = await this.deps.executor.executeRefinement(state, skillInfo.content);

			this.deps.refinementStore.updateAttempt(attemptId, {
				proposedTaskBody: result.proposedTaskBody,
				summary: result.summary,
				investigation: result.investigation,
			});

			const currentIssue = await this.deps.github.getIssue(owner, repo, issueNumber);
			if (!currentIssue || currentIssue.state === "closed") {
				this.deps.refinementStore.updateAttempt(attemptId, { state: "stale", failureReason: "issue closed during refinement" });
				await this.deps.github.postComment(owner, repo, issueNumber, "The issue changed during refinement. Please run `/yeetomatic issue-refinement` again.");
				return;
			}
			const currentFingerprint = fingerprintBody(currentIssue.body ?? "");
			if (currentFingerprint !== fingerprint) {
				this.deps.refinementStore.updateAttempt(attemptId, { state: "stale", failureReason: "issue body changed during refinement" });
				await this.deps.github.postComment(owner, repo, issueNumber, "The issue body changed during refinement. Please run `/yeetomatic issue-refinement` again.");
				return;
			}

			if (result.proposedTaskBody.length > 65535) {
				this.deps.refinementStore.updateAttempt(attemptId, { state: "failed", failureReason: "proposed task body exceeds GitHub size limit" });
				await this.deps.github.postComment(owner, repo, issueNumber, "Refinement produced a body that is too large for GitHub. Please run the command again with a narrower request.");
				return;
			}

			await this.deps.github.updateIssueBody(owner, repo, issueNumber, result.proposedTaskBody);
			this.deps.refinementStore.updateAttempt(attemptId, { state: "applied" });
			await this.deps.github.postComment(
				owner,
				repo,
				issueNumber,
				`Issue refined at the request of @${payload.sender.login}. The issue body now contains the Proposed Task. No implementation session was started.`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stdout.write(`[refinement] failed for ${key}: ${message}\n`);
			if (attemptId) {
				this.deps.refinementStore.updateAttempt(attemptId, { state: "failed", failureReason: message });
			}
			await this.deps.github.postComment(owner, repo, issueNumber, `Refinement failed: ${message}`);
		} finally {
			this.deps.tasks.unregister(key, registration);
			this.inFlight.delete(key);
			if (worktreePath) {
				await this.deps.workspaces.removeRefinementWorktree!(worktreePath);
			}
		}
	}

	private resolveContext(payload: { repository: { name: string; owner: { login: string } }; issue: { number: number } }) {
		const owner = payload.repository.owner.login;
		const repo = payload.repository.name;
		const issueNumber = payload.issue.number;
		return { owner, repo, issueNumber, key: issueSessionKey(owner, repo, issueNumber) };
	}

	private isEligibleForInstructions(payload: IssueRefinementInstructionPayload): boolean {
		const { owner, repo, issueNumber } = this.resolveContext(payload);
		const issue = payload.issue;

		if (payload.action !== "opened") {
			return false;
		}

		if (this.deps.isRepoManaged && !this.deps.isRepoManaged(owner, repo)) {
			return false;
		}

		if (this.deps.refinementEnabled === false) {
			return false;
		}

		if (issue.user?.login === this.deps.githubUsername) {
			return false;
		}

		if (issue.assignee?.login === this.deps.githubUsername || issue.assignees?.some((a) => a.login === this.deps.githubUsername)) {
			return false;
		}

		return true;
	}

	private async resolveSkill(owner: string, repo: string, worktreePath: string): Promise<{
		source: "repository-skill" | "prompt-defaults";
		content?: string;
		commit?: string;
	}> {
		const skillPath = path.join(worktreePath, ".pi/skills/issue-refinement/SKILL.md");
		try {
			statSync(skillPath);
			const content = readFileSync(skillPath, "utf-8");
			const commit = await this.getCommit(worktreePath);
			return { source: "repository-skill", content, commit };
		} catch {
			return { source: "prompt-defaults", commit: await this.getCommit(worktreePath) };
		}
	}

	private async getCommit(worktreePath: string): Promise<string | undefined> {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const execFileAsync = promisify(execFile);
		try {
			const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
			return stdout.trim();
		} catch {
			return undefined;
		}
	}

	private buildSessionState(
		owner: string,
		repo: string,
		issueNumber: number,
		title: string,
		body: string,
		workspacePath: string,
	): import("../../session/store.js").SessionState {
		return {
			owner,
			repo,
			issueNumber,
			title,
			body,
			status: "working",
			sessionPath: "",
			workspacePath,
			lastActivity: this.deps.clock.now().toISOString(),
			labels: [],
			seeded: false,
		};
	}
}
