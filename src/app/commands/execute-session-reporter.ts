import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GitHubService } from "../../ports/github-service.js";
import type { WorkspaceService } from "../../ports/workspace-service.js";
import type { SessionRepository } from "../../ports/session-repository.js";
import type { SessionState } from "../../session/store.js";
import type { FatalErrorCategory } from "../../self-monitor/types.js";
import { FatalSystemError, SelfMonitor } from "../../self-monitor/index.js";
import { isRateLimitError } from "../../executor/index.js";

const execFileAsync = promisify(execFile);

export class ExecuteSessionReporter {
	constructor(
		private readonly deps: {
			github: GitHubService;
			workspaces: WorkspaceService;
			sessions: SessionRepository;
			selfReportEnabled: boolean;
		},
	) {}

	async postFailureComment(
		owner: string,
		repo: string,
		issueNumber: number,
		error: unknown,
		context: string,
	): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		if (isRateLimitError(message)) {
			const body = [
				"**Build failed**",
				"",
				"TARS encountered a 429 rate-limit error from Ollama and auto-retry was exhausted. The session cannot continue until usage limits are reset or the model is switched.",
				"",
				`Error: ${message}`,
			].join("\n");
			await this.deps.github.postComment(owner, repo, issueNumber, body);
			return;
		}
		const stack = error instanceof Error ? error.stack ?? "" : "";
		const truncatedStack = stack.length > 3000 ? stack.slice(0, 3000) + "\n... (truncated)" : stack;
		const body = [
			"**TARS failed.**",
			"",
			`Context: ${context}`,
			`Error: ${message}`,
			"",
			"<details>",
			"<summary>Full trace</summary>",
			`<pre>${truncatedStack}</pre>`,
			"</details>",
		].join("\n");
		await this.deps.github.postComment(owner, repo, issueNumber, body);
	}

	async handleDeliveryFailure(
		owner: string,
		repo: string,
		issueNumber: number,
		state: SessionState,
		error: unknown,
	): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		const diagnostics = await this.gatherDeliveryDiagnostics(owner, repo, issueNumber, state);
		const scopeHint = this.getPATScopeHint(message);

		let commentBody: string;
		if (this.deps.selfReportEnabled) {
			const issueUrl = await this.fileSelfReport(this.createDeliveryFatalError(state, message, diagnostics));
			commentBody = [
				"**TARS delivery failed.**",
				"",
				scopeHint,
				`A bug report has been filed in \`mbrooks/tars\`: ${issueUrl}`,
				"",
				"<details>",
				"<summary>Delivery diagnostics</summary>",
				"",
				`Worktree: \`${state.workspacePath}\``,
				"",
				"Git status:",
				"```",
				diagnostics.gitStatus || "(clean)",
				"```",
				"",
				"Git diff:",
				"```",
				diagnostics.gitDiff || "(none)",
				"```",
				"</details>",
			].filter(Boolean).join("\n");
			process.stdout.write(`[execute] delivery failure self-reported for ${repo}#${issueNumber}: ${issueUrl}\n`);
		} else {
			const stack = error instanceof Error ? (error.stack ?? "") : "";
			const truncatedStack = stack.length > 3000 ? stack.slice(0, 3000) + "\n... (truncated)" : stack;
			commentBody = [
				"**TARS delivery failed.**",
				"",
				scopeHint,
				`Context: Delivering completed work`,
				`Error: ${message}`,
				"",
				"<details>",
				"<summary>Delivery diagnostics</summary>",
				"",
				`Worktree: \`${state.workspacePath}\``,
				"",
				"Git status:",
				"```",
				diagnostics.gitStatus || "(clean)",
				"```",
				"",
				"Git diff:",
				"```",
				diagnostics.gitDiff || "(none)",
				"```",
				"</details>",
				"",
				"<details>",
				"<summary>Full trace</summary>",
				`<pre>${truncatedStack}</pre>`,
				"</details>",
			].filter(Boolean).join("\n");
		}

		await this.deps.github.postComment(owner, repo, issueNumber, commentBody);
		await this.deps.sessions.updateStatus(owner, repo, issueNumber, "failed");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-feedback-required");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-pr-created");
		await this.deps.github.removeLabel(owner, repo, issueNumber, "tars-complete");
		await this.deps.github.addLabels(owner, repo, issueNumber, ["tars-working", "tars-delivery-failed"]);
	}

	private classifyDeliveryError(message: string): FatalErrorCategory {
		const lower = message.toLowerCase();
		if (lower.includes("refusing to allow a personal access token") && lower.includes("scope")) {
			return "github_pat_scope_missing";
		}
		return "git_worktree_failure";
	}

	private createDeliveryFatalError(
		state: SessionState,
		message: string,
		diagnostics: { gitStatus: string; gitDiff: string; lsWorkspace: string },
	): FatalSystemError {
		return new FatalSystemError({
			toolHistory: [
				{
					toolName: "workspace.commitAndPush/createPR",
					args: undefined,
					result: message,
					isError: true,
					timestamp: new Date().toISOString(),
				},
			],
			fatalError: {
				category: this.classifyDeliveryError(message),
				message,
				toolName: "workspace.commitAndPush/createPR",
			},
			systemEvidence: {
				whoami: process.env.USER ?? process.env.LOGNAME ?? "unknown",
				pwd: process.cwd(),
				workspacePath: state.workspacePath,
				lsWorkspace: diagnostics.lsWorkspace,
				gitStatus: diagnostics.gitStatus,
				gitDiff: diagnostics.gitDiff,
				gitBranch: `tars/issue-${state.issueNumber}`,
				nodeVersion: process.version,
				timestamp: new Date().toISOString(),
			},
		});
	}

	private async gatherDeliveryDiagnostics(
		owner: string,
		repo: string,
		issueNumber: number,
		state: SessionState,
	): Promise<{ gitStatus: string; gitDiff: string; lsWorkspace: string }> {
		const [gitStatus, gitDiff, lsWorkspace] = await Promise.all([
			this.deps.workspaces.getGitStatus(owner, repo, issueNumber).catch(() => "(failed)"),
			this.deps.workspaces.getGitDiff(owner, repo, issueNumber).catch(() => "(failed)"),
			this.getWorkspaceListing(state.workspacePath),
		]);
		return { gitStatus, gitDiff, lsWorkspace };
	}

	private async getWorkspaceListing(workspacePath: string): Promise<string> {
		try {
			const { stdout } = await execFileAsync("ls", ["-la", workspacePath], { timeout: 10000 });
			return stdout;
		} catch {
			return "(failed to list workspace)";
		}
	}

	private getPATScopeHint(message: string): string {
		const lower = message.toLowerCase();
		if (
			lower.includes("refusing to allow a personal access token") &&
			lower.includes("workflow") &&
			lower.includes("scope")
		) {
			return "The GitHub PAT is missing the `workflow` scope. Update the token in GitHub settings and restart TARS.";
		}
		return "";
	}

	private async fileSelfReport(error: FatalSystemError): Promise<string> {
		const body = SelfMonitor.formatBugReportBody(error.evidence);
		const title = SelfMonitor.getIssueTitle(error.evidence);
		return this.deps.github.fileSelfReport(title, body, ["tars-self-report", "bug"]);
	}
}
