import { describe, expect, it } from "vitest";

import {
  buildExecutionPrompt,
  buildPullRequestBody,
  normalizeExecutorResult,
} from "../src/executor.js";
import type { IssueExecutionContext } from "../src/types.js";

describe("executor helpers", () => {
  it("builds a prompt with issue and comments", () => {
    const context: IssueExecutionContext = {
      issue: {
        number: 42,
        title: "Implement feature",
        body: "Feature body",
        htmlUrl: "https://example.com",
        labels: [],
      },
      comments: [
        {
          id: 1,
          body: "Please handle edge cases.",
          author: "mbrooks",
          createdAt: "2026-04-20T03:30:00Z",
        },
      ],
      config: {
        githubToken: "token",
        githubOwner: "mbrooks",
        githubRepo: "tars",
        pollIntervalMs: 300000,
        branchPrefix: "tars/issue-",
        workingLabel: "tars-working",
        clarificationLabel: "needs-clarification",
        prCreatedLabel: "tars-pr-created",
        piAgentDryRun: false,
      },
    };

    const prompt = buildExecutionPrompt(context);

    expect(prompt).toContain("Issue #42: Implement feature");
    expect(prompt).toContain("Please handle edge cases.");
    expect(prompt).toContain("Do not edit secrets");
  });

  it("normalizes clarification responses", () => {
    const result = normalizeExecutorResult(
      {
        clarificationQuestion: "Should this support retries?",
      },
      7,
      "Retry support",
      "tars/issue-7",
    );

    expect(result.status).toBe("clarification");
    expect(result.message).toContain("support retries");
  });

  it("builds a PR body from change summary", () => {
    const body = buildPullRequestBody(5, "Fix bug", ["Added coverage", "Handled timeout path"]);

    expect(body).toContain("**Issue:** #5");
    expect(body).toContain("- Added coverage");
    expect(body).toContain("- Handled timeout path");
  });
});
