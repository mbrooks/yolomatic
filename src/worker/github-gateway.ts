import type { SessionState } from "../session/store.js";
import type {
	GitHubGatewayService,
	GatewayIssueComment,
	GatewayIssueDetail,
	GatewayPullRequestDetail,
	GatewayPullRequestSummary,
} from "../ports/github-gateway-service.js";
import type { ReviewComment } from "../ports/github-service.js";

/**
 * Error thrown when a worker tool request targets an owner/repo/issue/PR that
 * is not part of the live session. The gateway converts this into a structured
 * `scope` error response without performing the requested GitHub operation.
 */
export class GatewayScopeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GatewayScopeError";
	}
}

export interface GatewayToolRequest {
	tool: string;
	params: Record<string, unknown>;
}

export interface GatewayToolResponse {
	ok: boolean;
	data?: unknown;
	error?: string;
	/** Present when the failure was a scope rejection (no GitHub op performed). */
	scopeError?: boolean;
}

/**
 * Control-plane gateway that performs scoped GitHub operations on behalf of a
 * disposable worker. The worker never receives the GitHub token; it sends
 * {@link GatewayToolRequest}s over the worker session WebSocket and this
 * gateway validates each request against the live {@link SessionState} before
 * calling GitHub through the control plane's {@link GitHubGatewayService}.
 *
 * Allowed targets:
 * - the session's own issue (owner/repo/issueNumber from SessionState); and
 * - the PR associated with that issue: `state.prNumber` when present, plus any
 *   other open PR whose head is the session branch `yeetomatic/issue-{n}`.
 *
 * Any request targeting a different owner/repo/issue_number is rejected without
 * a GitHub call. A `pr_number` that is neither `state.prNumber` nor a session
 * branch PR is rejected after a single branch-PR resolution read (necessary to
 * support branch PRs the control plane has not yet linked); the target PR
 * operation itself is never performed for an out-of-scope PR.
 */
export class WorkerGitHubGateway {
	constructor(private readonly github: GitHubGatewayService) {}

	async handle(state: SessionState, request: GatewayToolRequest): Promise<GatewayToolResponse> {
		try {
			const data = await this.dispatch(state, request);
			return { ok: true, data };
		} catch (error) {
			if (error instanceof GatewayScopeError) {
				return { ok: false, error: error.message, scopeError: true };
			}
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: message };
		}
	}

	private async dispatch(state: SessionState, request: GatewayToolRequest): Promise<unknown> {
		switch (request.tool) {
			case "get_authenticated_user":
				return this.getAuthenticatedUser();

			case "fetch_issue":
				return this.fetchIssue(state, request.params);

			case "set_comment":
				return this.setComment(state, request.params);

			case "set_status":
				return this.setStatus(state, request.params);

			case "set_labels":
				return this.setLabels(state, request.params);

			case "update_issue":
				return this.updateIssue(state, request.params);

			case "fetch_pr":
				return this.fetchPr(state, request.params);

			case "set_pr_comment":
				return this.setPrComment(state, request.params);

			case "update_pr":
				return this.updatePr(state, request.params);

			case "list_pr_review_comments":
				return this.listPrReviewComments(state, request.params);

			default:
				throw new Error(`Unknown gateway tool: ${request.tool}`);
		}
	}

	private async getAuthenticatedUser(): Promise<{ login: string } | null> {
		return this.github.getAuthenticatedUser();
	}

	private async fetchIssue(
		state: SessionState,
		params: Record<string, unknown>,
	): Promise<{ issue: GatewayIssueDetail; comments: GatewayIssueComment[] }> {
		const issue = await this.github.getIssueDetail(state.owner, state.repo, state.issueNumber);
		if (!issue) {
			throw new Error(`Issue ${state.owner}/${state.repo}#${state.issueNumber} not found`);
		}
		const includeComments = params.include_comments !== false;
		const comments = includeComments
			? await this.github.listIssueComments(state.owner, state.repo, state.issueNumber)
			: [];
		return { issue, comments };
	}

	private async setComment(state: SessionState, params: Record<string, unknown>): Promise<{ comment_id: number }> {
		const body = asString(params.body);
		if (body === null) throw new Error("body is required");
		const commentId = await this.github.postComment(state.owner, state.repo, state.issueNumber, body);
		return { comment_id: commentId };
	}

	private async setStatus(
		state: SessionState,
		params: Record<string, unknown>,
	): Promise<{ state?: string; assignees?: string[] }> {
		const stateParam = asState(params.state);
		const assignee = asNullableString(params.assignee);
		const fields: { state?: "open" | "closed"; assignees?: string[] } = {};
		if (stateParam) fields.state = stateParam;
		if (assignee !== undefined) {
			fields.assignees = assignee === null ? [] : [assignee];
		}
		if (Object.keys(fields).length === 0) {
			throw new Error("set_status requires state and/or assignee");
		}
		await this.github.updateIssue(state.owner, state.repo, state.issueNumber, fields);
		return fields;
	}

	private async setLabels(state: SessionState, params: Record<string, unknown>): Promise<{ labels: string[] }> {
		const labels = asStringArray(params.labels);
		const addLabels = asStringArray(params.addLabels) ?? [];
		const removeLabels = asStringArray(params.removeLabels) ?? [];

		if (labels !== null) {
			await this.github.setLabels(state.owner, state.repo, state.issueNumber, labels);
			return { labels };
		}

		if (addLabels.length === 0 && removeLabels.length === 0) {
			throw new Error("set_labels requires labels, addLabels, or removeLabels");
		}

		const issue = await this.github.getIssueDetail(state.owner, state.repo, state.issueNumber);
		if (!issue) {
			throw new Error(`Issue ${state.owner}/${state.repo}#${state.issueNumber} not found`);
		}
		const current = issue.labels.filter((label) => !removeLabels.includes(label));
		const merged = [...current];
		for (const label of addLabels) {
			if (!merged.includes(label)) merged.push(label);
		}
		const finalLabels = merged.filter((label) => !removeLabels.includes(label));
		await this.github.setLabels(state.owner, state.repo, state.issueNumber, finalLabels);
		return { labels: finalLabels };
	}

	private async updateIssue(state: SessionState, params: Record<string, unknown>): Promise<{ updated: true }> {
		const fields: {
			title?: string;
			body?: string;
			state?: "open" | "closed";
			labels?: string[];
			assignees?: string[];
		} = {};
		const title = asNullableString(params.title);
		if (title !== undefined && title !== null) fields.title = title;
		const body = asNullableString(params.body);
		if (body !== undefined) fields.body = body ?? "";
		const stateParam = asState(params.state);
		if (stateParam) fields.state = stateParam;
		const labels = asStringArray(params.labels);
		if (labels !== null) fields.labels = labels;
		const assignees = asStringArray(params.assignees);
		if (assignees !== null) fields.assignees = assignees;

		if (Object.keys(fields).length === 0) {
			throw new Error("update_issue requires at least one field");
		}
		await this.github.updateIssue(state.owner, state.repo, state.issueNumber, fields);
		return { updated: true };
	}

	private async fetchPr(
		state: SessionState,
		params: Record<string, unknown>,
	): Promise<{ pr: GatewayPullRequestDetail; comments: GatewayIssueComment[] }> {
		const prNumber = await this.resolvePrNumber(state, params);
		const pr = await this.github.getPullRequestDetail(state.owner, state.repo, prNumber);
		if (!pr) {
			throw new Error(`Pull request ${state.owner}/${state.repo}#${prNumber} not found`);
		}
		const includeComments = params.include_comments !== false;
		const comments = includeComments
			? await this.github.listPullRequestComments(state.owner, state.repo, prNumber)
			: [];
		return { pr, comments };
	}

	private async setPrComment(
		state: SessionState,
		params: Record<string, unknown>,
	): Promise<{ comment_id: number }> {
		const prNumber = await this.resolvePrNumber(state, params);
		const body = asString(params.body);
		if (body === null) throw new Error("body is required");
		const commentId = await this.github.postPRComment(state.owner, state.repo, prNumber, body);
		return { comment_id: commentId };
	}

	private async updatePr(state: SessionState, params: Record<string, unknown>): Promise<{ updated: true }> {
		const prNumber = await this.resolvePrNumber(state, params);
		const fields: { title?: string; body?: string; state?: "open" | "closed"; labels?: string[] } = {};
		const title = asNullableString(params.title);
		if (title !== undefined && title !== null) fields.title = title;
		const body = asNullableString(params.body);
		if (body !== undefined) fields.body = body ?? "";
		const stateParam = asState(params.state);
		if (stateParam) fields.state = stateParam;
		const labels = asStringArray(params.labels);
		if (labels !== null) fields.labels = labels;

		if (Object.keys(fields).length === 0) {
			throw new Error("update_pr requires at least one field");
		}
		await this.github.updatePullRequest(state.owner, state.repo, prNumber, fields);
		return { updated: true };
	}

	private async listPrReviewComments(
		state: SessionState,
		params: Record<string, unknown>,
	): Promise<{ comments: ReviewComment[] }> {
		const prNumber = await this.resolvePrNumber(state, params);
		const comments = await this.github.listPullRequestReviewComments(state.owner, state.repo, prNumber);
		return { comments };
	}

	/**
	 * Resolve the in-scope PR number for a PR tool call. If the worker supplies
	 * `pr_number`, it must match `state.prNumber` or an open PR on the session
	 * branch; otherwise the request is rejected as a scope error. If omitted,
	 * the session's linked PR is used, falling back to the first open branch PR.
	 */
	private async resolvePrNumber(
		state: SessionState,
		params: Record<string, unknown>,
	): Promise<number> {
		const requested = asNumber(params.pr_number);
		if (requested !== null && requested !== undefined) {
			if (state.prNumber !== undefined && requested === state.prNumber) {
				return requested;
			}
			const branchPrs = await this.listBranchPrs(state);
			if (branchPrs.some((pr) => pr.number === requested)) {
				return requested;
			}
			throw new GatewayScopeError(
				`pr_number ${requested} is not associated with session ${state.owner}/${state.repo}#${state.issueNumber}`,
			);
		}

		if (state.prNumber !== undefined) {
			return state.prNumber;
		}

		const branchPrs = await this.listBranchPrs(state);
		if (branchPrs.length === 0) {
			throw new Error(
				`No pull request is associated with session ${state.owner}/${state.repo}#${state.issueNumber}`,
			);
		}
		return branchPrs[0].number;
	}

	private async listBranchPrs(state: SessionState): Promise<GatewayPullRequestSummary[]> {
		const head = `yeetomatic/issue-${state.issueNumber}`;
		return this.github.listPullRequestsForHead(state.owner, state.repo, head, "open");
	}
}

function asString(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	return value;
}

function asNullableString(value: unknown): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value === "string") return value;
	return undefined;
}

function asState(value: unknown): "open" | "closed" | null {
	if (value === "open" || value === "closed") return value;
	return null;
}

function asStringArray(value: unknown): string[] | null {
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value)) return null;
	return value.filter((item): item is string => typeof item === "string");
}

function asNumber(value: unknown): number | null | undefined {
	if (value === undefined || value === null) return null;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && /^\d+$/u.test(value)) return Number(value);
	return null;
}