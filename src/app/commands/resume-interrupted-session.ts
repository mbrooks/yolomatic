import { isTerminalStatus } from "../../session/store.js";
import { issueSessionKey, markIssueWorking } from "./workflow-helpers.js";
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
		const key = issueSessionKey(owner, repo, issueNumber);
		const session = await this.deps.sessions.get(owner, repo, issueNumber, "implementation");
		if (!session) {
			process.stdout.write(`[resume] no session for ${key}\n`);
			return;
		}

		if (isTerminalStatus(session.status)) {
			process.stdout.write(`[resume] session ${key} is in terminal status (${session.status}), skipping\n`);
			return;
		}

		process.stdout.write(`[resume] restarting interrupted session ${key} from ${session.status}\n`);

		const queuedComment = session.queuedComments?.join("\n\n");

		try {
			if (session.status === "working") {
				await this.deps.github.postComment(
					owner,
					repo,
					issueNumber,
					"Yolomatic was restarted while working on this issue. Resuming work...",
				);
				await this.executor.run(session, queuedComment);
			} else if (session.status === "pending") {
				await markIssueWorking(this.deps.github, owner, repo, issueNumber, "Yolomatic was restarted while queued. Picking up work...");
				await this.executor.run(session, queuedComment);
			} else if (session.status === "waiting-feedback") {
				await markIssueWorking(
					this.deps.github,
					owner,
					repo,
					issueNumber,
					"Yolomatic was restarted with queued feedback. Resuming work...",
				);
				await this.executor.run(session, queuedComment);
			} else {
				await markIssueWorking(this.deps.github, owner, repo, issueNumber, "Yolomatic was restarted. Resuming work...");
				await this.executor.run(session, queuedComment);
			}
		} finally {
			const latest = await this.deps.sessions.get(owner, repo, issueNumber, "implementation");
			if (latest && (latest.resumeOnBoot || latest.queuedComments)) {
				latest.resumeOnBoot = undefined;
				latest.queuedComments = undefined;
				await this.deps.sessions.save(latest);
			}
		}
	}
}
