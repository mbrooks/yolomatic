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

export type SessionType = "github_issue" | "cron";

export type Session = {
	owner: string;
	repo: string;
	issueNumber: number;
	status: SessionStatus;
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
	sessionType: SessionType;
	cronJobId?: string;
	cronJobName?: string;
	cronScheduleExpression?: string;
	cronTriggerTime?: string;
};

export type RepoSummary = {
	owner: string;
	repo: string;
	sessionCount: number;
	activeCount: number;
	cronCount: number;
	lastActivity: string | null;
};

export type StatusResponse = {
	agent: Exclude<AgentStatus, "offline">;
	uptime: string;
	draining: boolean;
	repos: RepoSummary[];
	sessions: Session[];
};

export type CronScheduleType = "daily" | "weekly" | "interval" | "custom";

export type CronJob = {
	id: string;
	owner: string;
	repo: string;
	name: string;
	description: string;
	prompt: string;
	scheduleType: CronScheduleType;
	scheduleValue: string;
	branch: string;
	notificationChannel: string | null;
	enabled: boolean;
	nextRunAt: string;
	lastRunAt: string | null;
	lastRunStatus: "success" | "failure" | null;
	lastError: string | null;
	createdAt: string;
	prUrl: string | null;
	prNumber: number | null;
};

export type CronRun = {
	id: string;
	cronId: string;
	owner: string;
	repo: string;
	startedAt: string;
	finishedAt: string;
	status: "success" | "failure";
	output: string;
	error: string | null;
};
