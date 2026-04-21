export interface GitHubLabel {
  name: string;
}

export interface IssueComment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: GitHubLabel[];
  htmlUrl: string;
}

export interface PullRequest {
  number: number;
  htmlUrl: string;
}

export interface TarsConfig {
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  pollIntervalMs: number;
  branchPrefix: string;
  workingLabel: string;
  clarificationLabel: string;
  prCreatedLabel: string;
  piAgentModel?: string;
  piAgentDryRun: boolean;
}

export type ExecutorStatus = "complete" | "clarification" | "error";

export interface ExecutorResult {
  status: ExecutorStatus;
  message?: string;
  prTitle?: string;
  prBody?: string;
  branchName?: string;
}

export interface IssueExecutionContext {
  issue: Issue;
  comments: IssueComment[];
  config: TarsConfig;
}

export interface PiAgentResponse {
  status?: string;
  message?: string;
  summary?: string;
  needsClarification?: boolean;
  clarificationQuestion?: string;
  prTitle?: string;
  prBody?: string;
  branchName?: string;
}
