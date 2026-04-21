import dotenv from "dotenv";

import { TaskExecutor } from "./executor.js";
import { GitHubClient } from "./github.js";
import type { ExecutorResult, TarsConfig } from "./types.js";

dotenv.config();

async function main(): Promise<void> {
  const config = loadConfig();
  const github = new GitHubClient(
    config.githubOwner,
    config.githubRepo,
    config.githubToken,
  );
  const executor = new TaskExecutor();

  for (;;) {
    try {
      await runPollCycle(github, executor, config);
    } catch (error) {
      console.error("poll cycle failed", error);
    }

    await sleep(config.pollIntervalMs);
  }
}

export async function runPollCycle(
  github: GitHubClient,
  executor: TaskExecutor,
  config: TarsConfig,
): Promise<void> {
  const issues = await github.getOpenIssues([
    config.workingLabel,
    config.clarificationLabel,
  ]);
  const nextIssue = issues[0];

  if (!nextIssue) {
    console.log("No eligible issues found.");
    return;
  }

  await github.addLabel(nextIssue.number, config.workingLabel);
  await github.postComment(
    nextIssue.number,
    "Picked up by TARS. Working on it...",
  );

  try {
    const comments = await github.getIssueComments(nextIssue.number);
    const result = await executor.execute({
      issue: nextIssue,
      comments,
      config,
    });

    await handleExecutorResult(github, config, nextIssue.number, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await github.postComment(
      nextIssue.number,
      `TARS hit an error while processing this issue:\n\n${message}`,
    );
    throw error;
  } finally {
    await github.removeLabel(nextIssue.number, config.workingLabel);
  }
}

async function handleExecutorResult(
  github: GitHubClient,
  config: TarsConfig,
  issueNumber: number,
  result: ExecutorResult,
): Promise<void> {
  if (result.status === "clarification") {
    await github.addLabel(issueNumber, config.clarificationLabel);
    await github.postComment(
      issueNumber,
      result.message || "TARS needs clarification before continuing.",
    );
    return;
  }

  if (result.status === "error") {
    await github.postComment(
      issueNumber,
      `TARS failed to complete this issue:\n\n${result.message || "Unknown error"}`,
    );
    return;
  }

  if (!result.prTitle || !result.prBody || !result.branchName) {
    throw new Error("Executor completed without PR metadata.");
  }

  const pullRequest = await github.createPR(
    result.prTitle,
    result.prBody,
    result.branchName,
    "main",
  );

  await github.addLabel(issueNumber, config.prCreatedLabel);
  await github.removeLabel(issueNumber, config.clarificationLabel);
  await github.postComment(
    issueNumber,
    `TARS completed this task and opened PR #${pullRequest.number}: ${pullRequest.htmlUrl}`,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TarsConfig {
  const githubToken = env.GITHUB_TOKEN;
  const githubOwner = env.GITHUB_OWNER;
  const githubRepo = env.GITHUB_REPO;

  if (!githubToken || !githubOwner || !githubRepo) {
    throw new Error("GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO are required.");
  }

  return {
    githubToken,
    githubOwner,
    githubRepo,
    pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? "300000"),
    branchPrefix: env.BRANCH_PREFIX ?? "tars/issue-",
    workingLabel: env.WORKING_LABEL ?? "tars-working",
    clarificationLabel: env.CLARIFICATION_LABEL ?? "needs-clarification",
    prCreatedLabel: env.PR_CREATED_LABEL ?? "tars-pr-created",
    piAgentModel: env.PI_AGENT_MODEL,
    piAgentDryRun: env.PI_AGENT_DRY_RUN === "true",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main();
