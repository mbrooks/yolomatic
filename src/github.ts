import { Octokit } from "@octokit/rest";

import type { Issue, IssueComment, PullRequest } from "./types.js";

type RestClient = Pick<Octokit, "issues" | "pulls">;

export class GitHubClient {
  private readonly octokit: RestClient;

  constructor(
    private readonly owner: string,
    private readonly repo: string,
    token: string,
    octokit?: RestClient,
  ) {
    this.octokit = octokit ?? new Octokit({ auth: token });
  }

  async getOpenIssues(excludeLabels: string[]): Promise<Issue[]> {
    const response = await this.octokit.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      state: "open",
      per_page: 100,
    });

    return response.data
      .filter((item) => !("pull_request" in item))
      .map((item) => ({
        number: item.number,
        title: item.title,
        body: item.body ?? "",
        labels: item.labels.map((label) => ({
          name: typeof label === "string" ? label : label.name ?? "",
        })),
        htmlUrl: item.html_url,
      }))
      .filter((issue) => !hasAnyLabel(issue, excludeLabels));
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    await this.octokit.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      labels: [label],
    });
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.issues.removeLabel({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        name: label,
      });
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  async postComment(issueNumber: number, body: string): Promise<void> {
    await this.octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body,
    });
  }

  async createPR(
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<PullRequest> {
    const response = await this.octokit.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title,
      body,
      head,
      base,
    });

    return {
      number: response.data.number,
      htmlUrl: response.data.html_url,
    };
  }

  async getIssueComments(issueNumber: number): Promise<IssueComment[]> {
    const response = await this.octokit.issues.listComments({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      per_page: 100,
    });

    return response.data.map((comment) => ({
      id: comment.id,
      body: comment.body ?? "",
      author: comment.user?.login ?? "unknown",
      createdAt: comment.created_at,
    }));
  }
}

export function hasAnyLabel(issue: Issue, labels: string[]): boolean {
  const issueLabels = new Set(issue.labels.map((label) => label.name));
  return labels.some((label) => issueLabels.has(label));
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 404
  );
}
