import {
  createAgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import { readFileSync } from "fs";
import { join } from "path";

import type {
  ExecutorResult,
  IssueExecutionContext,
} from "./types.js";

export class TaskExecutor {
  async execute(context: IssueExecutionContext): Promise<ExecutorResult> {
    if (context.config.piAgentDryRun) {
      return {
        status: "complete",
        message: "PI agent dry run enabled. No changes were executed.",
        prTitle: `TARS: Resolve issue #${context.issue.number}`,
        prBody: buildPullRequestBody(context.issue.number, context.issue.title, [
          "Dry run execution completed",
        ]),
        branchName: `${context.config.branchPrefix}${context.issue.number}`,
      };
    }

    const prompt = buildExecutionPrompt(context);
    const branchName = `${context.config.branchPrefix}${context.issue.number}`;
    const rawResult = await runPiAgentSession(prompt);

    return normalizeExecutorResult(
      rawResult,
      context.issue.number,
      context.issue.title,
      branchName,
    );
  }
}

async function runPiAgentSession(prompt: string): Promise<string> {
  const { session } = await createAgentSession({
    cwd: process.cwd(),
  });
  let output = "";
  console.log("[pi] session created");

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    logSessionEvent(event);

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      output += event.assistantMessageEvent.delta;
      process.stdout.write(event.assistantMessageEvent.delta);
    }

    if (event.type === "turn_end") {
      const text = extractMessageText(event.message);
      if (text) {
        output = text;
      }
      process.stdout.write("\n");
    }
  });

  try {
    console.log("[pi] prompt start");
    await session.prompt(prompt);
    console.log("[pi] prompt complete");
    return output.trim();
  } finally {
    unsubscribe();
    session.dispose();
    console.log("[pi] session disposed");
  }
}

export function buildExecutionPrompt(context: IssueExecutionContext): string {
  const soulPath = join(process.cwd(), "SOUL.md");
  const soulContent = readFileSync(soulPath, "utf-8");

  const commentBlock =
    context.comments.length === 0
      ? "No prior comments."
      : context.comments
          .map(
            (comment) =>
              `- ${comment.author} at ${comment.createdAt}: ${comment.body.replace(/\s+/g, " ").trim()}`,
          )
          .join("\n");

  return [
    "You are TARS, an autonomous coding agent working from a GitHub issue.",
    `Repository: ${context.config.githubOwner}/${context.config.githubRepo}`,
    `Issue #${context.issue.number}: ${context.issue.title}`,
    "",
    "---",
    "",
    "## YOUR IDENTITY (SOUL.md)",
    "",
    soulContent,
    "",
    "---",
    "",
    "Issue body:",
    context.issue.body || "(empty)",
    "",
    "Issue comments:",
    commentBlock,
    "",
    "Guardrails:",
    "- Only push to feature branches under the configured branch prefix.",
    "- Do not edit secrets, .env files, or credential material.",
    "- Ask for clarification if the task is ambiguous or blocked.",
    "- Summarize changes clearly when complete.",
  ].join("\n");
}

export function normalizeExecutorResult(
  result: unknown,
  issueNumber: number,
  issueTitle: string,
  branchName: string,
): ExecutorResult {
  const text = asResultText(result);
  const summary = text || "Task completed.";

  if (looksLikeClarification(summary)) {
    return {
      status: "clarification",
      message: summary,
      branchName,
    };
  }

  if (looksLikeError(summary)) {
    return {
      status: "error",
      message: summary,
      branchName,
    };
  }

  return {
    status: "complete",
    message: summary,
    prTitle: `TARS: Resolve issue #${issueNumber}`,
    prBody: buildPullRequestBody(issueNumber, issueTitle, [summary]),
    branchName,
  };
}

export function buildPullRequestBody(
  issueNumber: number,
  issueTitle: string,
  changes: string[],
): string {
  const lines = changes.map((change) => `- ${change}`);

  return [
    "## TARS Task Completion",
    "",
    `**Issue:** #${issueNumber}`,
    `**Task:** ${issueTitle}`,
    "",
    "### Changes",
    ...lines,
    "",
    "### Checklist",
    "- [ ] Tests pass",
    "- [ ] Guardrails pass",
    "",
    "---",
    "*Created by TARS (Task Automation & Response System)*",
  ].join("\n");
}

function asResultText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  if (typeof result === "object" && result !== null) {
    if (
      "clarificationQuestion" in result &&
      typeof result.clarificationQuestion === "string"
    ) {
      return result.clarificationQuestion;
    }

    if ("summary" in result && typeof result.summary === "string") {
      return result.summary;
    }

    const text = extractMessageText(result);
    if (text) {
      return text;
    }
  }

  return "";
}

function extractMessageText(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }

  if (typeof message !== "object" || message === null) {
    return "";
  }

  if ("content" in message && Array.isArray(message.content)) {
    const text = message.content
      .map((part) => {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");

    if (text) {
      return text;
    }
  }

  if ("text" in message && typeof message.text === "string") {
    return message.text;
  }

  if ("message" in message && typeof message.message === "string") {
    return message.message;
  }

  return "";
}

function looksLikeClarification(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    text.trim().endsWith("?") ||
    normalized.includes("need clarification") ||
    normalized.includes("needs clarification") ||
    normalized.includes("clarification") ||
    normalized.includes("question for you") ||
    normalized.includes("could you clarify") ||
    normalized.includes("can you clarify")
  );
}

function looksLikeError(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.startsWith("error:") ||
    normalized.includes("failed") ||
    normalized.includes("exception") ||
    normalized.includes("unable to")
  );
}

function logSessionEvent(event: AgentSessionEvent): void {
  switch (event.type) {
    case "agent_start":
      console.log("[pi] agent_start");
      return;
    case "agent_end":
      console.log("[pi] agent_end");
      return;
    case "turn_start":
      console.log("[pi] turn_start");
      return;
    case "turn_end":
      console.log(`[pi] turn_end tools=${event.toolResults.length}`);
      return;
    case "tool_execution_start":
      console.log(
        `[pi] tool_start ${event.toolName} ${safeJson(event.args)}`,
      );
      return;
    case "tool_execution_update":
      console.log(
        `[pi] tool_update ${event.toolName} ${truncateLog(
          safeJson(event.partialResult),
        )}`,
      );
      return;
    case "tool_execution_end":
      console.log(
        `[pi] tool_end ${event.toolName} error=${event.isError} ${truncateLog(
          safeJson(event.result),
        )}`,
      );
      return;
    case "message_start":
      console.log(`[pi] message_start ${event.message.role}`);
      return;
    case "message_end":
      console.log(`[pi] message_end ${event.message.role}`);
      return;
    default:
      return;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateLog(value: string, maxLength = 400): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
