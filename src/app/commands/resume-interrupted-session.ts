import type { SessionRepository } from "../../ports/session-repository.js";
import type { GitHubService } from "../../ports/github-service.js";
import { ExecuteSession, type ExecuteSessionDeps } from "./execute-session.js";

export class ResumeInterruptedSession {
	private readonly executor: ExecuteSession;

	constructor(
		private readonly deps: {
			sessions: SessionRepository;
			github: GitHubService;
			executor: ExecuteSessionDeps;
		},
	) {
		this.executor = new ExecuteSession(deps.executor);
	}

	async execute(owner: string, repo: string, issueNumber: number): Promise<void> {
		const key = `${owner}/${repo}#${issueNumber}`;
		const session = await this.deps.sessions.get(owner, repo, issueNumber);
		if (!session) {
			process.stdout.write(`[resume] no session for ${key}\n`);
			return;
		}
		if (session.status !== "working") {
			process.stdout.write(`[resume] session ${key} is not in working status (${session.status})\n`);
			return;
		}
		process.stdout.write(`[resume] restarting interrupted session ${key}\n`);
		await this.deps.github.postComment(
			owner,
			repo,
			issueNumber,
			"TARS was restarted while working on this issue. Resuming work...",
		);
		await this.executor.run(session);
	}
}
