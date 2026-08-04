export type AgentStatus = "online" | "busy" | "feedback" | "offline";

export type SessionStatus =
	| "pending"
	| "working"
	| "waiting-feedback"
	| "paused"
	| "complete"
	| "failed"
	| "cancelled";

export type StaleInfo = {
	isStale: boolean;
	ageMinutes: number;
	classification: string;
	worktreeDirty: boolean | null;
	issueState: string | null;
	prState: string | null;
};

export type LogEntry = {
	timestamp: string;
	level: "info" | "error" | "warn" | "tool" | "assistant";
	message: string;
	details?: Record<string, unknown>;
};

export type SessionLogResponse = {
	available: boolean;
	logs: LogEntry[];
};

export type RefinementAttempt = {
	id: string;
	requester: string;
	instructionSource: string;
	repoCommit?: string;
	state: string;
	failureReason?: string;
	summary?: string;
	investigation?: string;
	createdAt: string;
	updatedAt: string;
};

export type RefinementAttemptsResponse = {
	attempts: RefinementAttempt[];
};

export type RefinementLogResponse = {
	available: boolean;
	logs: LogEntry[];
};

export type SkillSource = "server" | "repo" | "inherited";

export type ServerSkill = {
	id: string;
	name: string;
	description: string;
	content: string;
	updatedAt: string;
	createdAt: string;
};

export type RepoSkill = {
	name: string;
	description: string;
	content: string;
	updatedAt: string;
	source: SkillSource;
};

export type Session = {
	kind: "implementation" | "refinement";
	owner: string;
	repo: string;
	issueNumber: number;
	status: SessionStatus;
	title: string | null;
	body: string | null;
	summary: string | null;
	workspacePath: string;
	branch: string;
	lastActivity: string;
	createdAt: string | null;
	prUrl: string | null;
	prNumber: number | null;
	risk: {
		suspectedMisroute: boolean;
		reasons: string[];
		referencedIssueNumber: number | null;
	};
	staleDetectedAt: string | null;
	staleReason: string | null;
	stale: StaleInfo | null;
	taskStartedAt: string | null;
	taskFinishedAt: string | null;
	totalExecutionTimeMs: number | null;
};

export type RepoSummary = {
	owner: string;
	repo: string;
	sessionCount: number;
	activeCount: number;
	implementationSessionCount: number;
	implementationActiveCount: number;
	refinementSessionCount: number;
	refinementActiveCount: number;
	lastActivity: string | null;
};

export type StatusResponse = {
	agent: Exclude<AgentStatus, "offline">;
	uptime: string;
	draining: boolean;
	repos: RepoSummary[];
	sessions: Session[];
};
