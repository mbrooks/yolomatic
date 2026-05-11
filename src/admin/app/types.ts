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

export type SessionLogResponse = {
	available: boolean;
	truncated?: boolean;
	totalLines?: number;
	lines?: string[];
	error?: string;
};

export type Session = {
	owner: string;
	repo: string;
	issueNumber: number;
	status: SessionStatus;
	workspacePath: string;
	branch: string;
	lastActivity: string;
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
};

export type RepoSummary = {
	owner: string;
	repo: string;
	sessionCount: number;
	activeCount: number;
};

export type StatusResponse = {
	agent: Exclude<AgentStatus, "offline">;
	uptime: string;
	repos: RepoSummary[];
	sessions: Session[];
};
