import type { Octokit } from "@octokit/rest";
import type {
	CreatedPR,
	PullRequestInfo,
	ReviewComment,
} from "../../../ports/github-service.js";
import type {
	GatewayPullRequestDetail,
	GatewayPullRequestSummary,
	GatewayPullRequestUpdateFields,
} from "../../../ports/github-gateway-service.js";
import { mapReviewComment } from "./shared/mappers.js";
import { buildStatefulUpdateFields } from "./shared/update-payloads.js";

/**
 * Focused delegate for pull-request reads, review comments, branch updates,
 * creation, ready-for-review, and metadata updates. Preserves the
 * method-specific null/empty fallbacks and the merge-conflict guidance on
 * `updatePullRequestBranch`.
 *
 * Label handling for `updatePullRequest` lives in the façade (it composes this
 * delegate with the issue delegate's `setLabels`); this delegate's
 * `updatePullRequestMetadata` only handles title/body/state.
 */
export class PullRequestDelegate {
	constructor(private readonly octokit: Octokit) {}

	async getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequestInfo | null> {
		try {
			const { data } = await this.octokit.pulls.get({ owner, repo, pull_number: prNumber });
			return {
				head: data.head,
				base: { ref: data.base?.ref ?? "" },
				state: data.state,
				merged: data.merged ?? false,
				mergeable: data.mergeable ?? null,
				mergeableState: data.mergeable_state ?? "unknown",
				draft: data.draft ?? false,
			};
		} catch {
			return null;
		}
	}

	async updatePullRequestBranch(
		owner: string,
		repo: string,
		prNumber: number,
		expectedHeadSha?: string,
	): Promise<void> {
		try {
			await this.octokit.pulls.updateBranch({
				owner,
				repo,
				pull_number: prNumber,
				...(expectedHeadSha ? { expected_head_sha: expectedHeadSha } : {}),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/(merge conflict|422|409|cannot be merged|non-fast-forward|unresolvable)/i.test(message)) {
				throw new Error(
					`[github] update-branch failed for ${owner}/${repo}#${prNumber}: ${message}. ` +
						`Resolve the conflict manually before relaunching the worker.`,
				);
			}
			throw error;
		}
	}

	async createPullRequest(
		owner: string,
		repo: string,
		title: string,
		body: string,
		head: string,
		base: string,
		draft?: boolean,
	): Promise<CreatedPR | null> {
		try {
			const pr = await this.octokit.pulls.create({
				owner,
				repo,
				title,
				body,
				head,
				base,
				...(draft !== undefined ? { draft } : {}),
			});
			return this.mapCreatedPR(pr.data);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("No commits between")) {
				return null;
			}
			throw error;
		}
	}

	async markPullRequestReadyForReview(owner: string, repo: string, prNumber: number): Promise<void> {
		// GitHub exposes "ready for review" only as the GraphQL
		// `markPullRequestReadyForReview` mutation. The REST
		// `POST /repos/{owner}/{repo}/pulls/{pull_number}/ready-for-review`
		// route does not exist and returns 404, which previously left draft PRs
		// stuck after creation. Resolve the PR's global node id, then flip it.
		const nodeQuery = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) { id }
  }
}`;
		const nodeResult = await this.octokit.graphql<{ repository?: { pullRequest?: { id?: string } } }>(nodeQuery, {
			owner,
			repo,
			number: prNumber,
		});
		const pullRequestId = nodeResult?.repository?.pullRequest?.id;
		if (!pullRequestId) {
			throw new Error(`Could not resolve GitHub node id for pull request #${prNumber} in ${owner}/${repo}.`);
		}
		const mutation = `mutation MarkPullRequestReadyForReview($input: MarkPullRequestReadyForReviewInput!) {
  markPullRequestReadyForReview(input: $input) {
    pullRequest { id isDraft }
  }
}`;
		await this.octokit.graphql(mutation, { input: { pullRequestId } });
	}

	async listPullRequests(
		owner: string,
		repo: string,
		options: { head: string; base: string; state: string },
	): Promise<CreatedPR[]> {
		const { data } = await this.octokit.pulls.list({
			owner,
			repo,
			head: options.head,
			base: options.base,
			state: options.state as "open" | "closed" | "all",
		});
		return data.map((pr) => this.mapCreatedPR(pr));
	}

	async listOpenPullRequests(owner: string, repo: string): Promise<number[]> {
		const numbers: number[] = [];
		const perPage = 100;
		const maxPrs = 500;
		let page = 1;
		try {
			while (true) {
				const { data } = await this.octokit.pulls.list({
					owner,
					repo,
					state: "open",
					per_page: perPage,
					page,
				});
				for (const pr of data) {
					numbers.push(pr.number);
					if (numbers.length >= maxPrs) return numbers;
				}
				if (data.length < perPage) return numbers;
				page += 1;
			}
		} catch {
			return numbers;
		}
	}

	async postPRComment(owner: string, repo: string, prNumber: number, body: string): Promise<number> {
		const response = await this.octokit.issues.createComment({ owner, repo, issue_number: prNumber, body });
		return response.data.id;
	}

	async listReviewComments(
		owner: string,
		repo: string,
		prNumber: number,
		reviewId: number,
	): Promise<ReviewComment[]> {
		try {
			const { data } = await this.octokit.pulls.listReviewComments({
				owner,
				repo,
				pull_number: prNumber,
				review_id: reviewId,
			});
			return data.map((rc) => mapReviewComment(rc));
		} catch {
			return [];
		}
	}

	async getPullRequestDetail(owner: string, repo: string, prNumber: number): Promise<GatewayPullRequestDetail | null> {
		try {
			const { data } = await this.octokit.pulls.get({ owner, repo, pull_number: prNumber });
			return {
				number: data.number,
				title: data.title,
				body: data.body ?? "",
				state: data.state === "closed" ? "closed" : "open",
				merged: data.merged ?? false,
				head_ref: data.head?.ref ?? "",
				base_ref: data.base?.ref ?? "",
				html_url: data.html_url,
				created_at: data.created_at,
				updated_at: data.updated_at,
			};
		} catch {
			return null;
		}
	}

	async listPullRequestReviewComments(owner: string, repo: string, prNumber: number): Promise<ReviewComment[]> {
		try {
			const { data } = await this.octokit.pulls.listReviewComments({
				owner,
				repo,
				pull_number: prNumber,
				per_page: 100,
			});
			return data.map((rc) => mapReviewComment(rc));
		} catch {
			return [];
		}
	}

	async listPullRequestsForHead(
		owner: string,
		repo: string,
		head: string,
		state: "open" | "closed" | "all",
	): Promise<GatewayPullRequestSummary[]> {
		try {
			const { data } = await this.octokit.pulls.list({
				owner,
				repo,
				head,
				state,
				per_page: 100,
			});
			return data.map((pr) => ({
				number: pr.number,
				title: pr.title,
				html_url: pr.html_url,
				head_ref: pr.head?.ref ?? "",
				base_ref: pr.base?.ref ?? "",
				state: pr.state,
				// The list endpoint does not return `merged`; use state as a proxy. The
				// gateway only uses these summaries for scoping, not for merged status.
				merged: false,
			}));
		} catch {
			return [];
		}
	}

	async updatePullRequestMetadata(
		owner: string,
		repo: string,
		prNumber: number,
		fields: Pick<GatewayPullRequestUpdateFields, "title" | "body" | "state">,
	): Promise<void> {
		const update = buildStatefulUpdateFields(fields);
		if (Object.keys(update).length === 0) return;
		await this.octokit.pulls.update({ owner, repo, pull_number: prNumber, ...update });
	}

	private mapCreatedPR(pr: { number: number; html_url: string }): CreatedPR {
		return { number: pr.number, html_url: pr.html_url };
	}
}