# GitHub Issues Extension for pi-coding-agent (worker/gateway mode)

This extension provides scoped GitHub issue and pull-request management tools for the Yeetomatic **disposable worker**. The worker never receives `GITHUB_TOKEN`; every tool call is routed over the worker session WebSocket to the control-plane `WorkerGitHubGateway`, which performs the GitHub call on the worker's behalf and enforces session scope.

## How it works

1. The worker runtime (`src/worker/runtime.ts`) opens the per-session WebSocket to the control plane and installs a gateway transport (`src/worker/github-gateway-client.ts`).
2. The worker loads this extension from its trusted runtime image and suppresses stale workspace copies, so an older issue worktree cannot redirect the tools to an outdated gateway client.
3. The pi extension registers tools that call `callGitHubGateway(tool, params)`.
4. Each call is sent as a `tool_request` protocol message; the control plane acks receipt, validates the request against the live `SessionState`, performs the GitHub operation through the control plane's `GitHubService` (which holds the token), and replies with a `tool_response` carrying the result.
5. The worker extension never reads `GITHUB_TOKEN`, never builds an Octokit, and never calls the GitHub API directly.

See `design/protocol-session-messages.md` for the `tool_request` / `tool_response` protocol and `src/worker/github-gateway.ts` for the scoping rules.

## Scope enforcement

All operations are scoped to the live session:

- **Issue tools** target the session's own issue (`owner`/`repo`/`issueNumber` from `SessionState`). They do not accept `owner`/`repo`/`issue_number` parameters, so the worker cannot attempt an out-of-scope call.
- **PR tools** target the PR associated with the session: `state.prNumber` when present, plus any other open PR whose head is the session branch `yeetomatic/issue-{issueNumber}` (resolved via `listPullRequestsForHead`). PR tools accept an optional `pr_number` that must match one of these; any other `pr_number` is rejected as a scope error without performing the target GitHub operation.

Requests targeting a different `owner`, `repo`, or `issue_number` are rejected without any GitHub call. Merging PRs, creating PRs, updating PR branches, editing/deleting comments, and pushing code remain control-plane-owned and are **not** exposed.

## Tools

### `github_get_authenticated_user`

Get the GitHub user the control plane authenticates as for this session. No token is exposed to the worker. (The token-probe form is removed; this is a scoped gateway call.)

### `github_fetch_issue`

Read the live session issue: `title`, `body`, `state`, `labels`, `assignees`, and (by default) comments.

- `include_comments` (optional, default `true`): include issue comments (author, body, timestamps, `html_url`).

The tool renders the issue body, state, labels, assignees, and comments into the model-visible text content (not just the title), so the agent can actually read the issue description. The full structured payload is also attached to the tool result `details` for logs/UI.

### `github_set_comment`

Add a comment to the live session issue.

- `body` (required): comment text (Markdown supported).

### `github_set_status`

Update the live session issue state and/or assignee.

- `state` (optional): `"open"` or `"closed"`.
- `assignee` (optional): username, or `null` to unassign.

### `github_set_labels`

Replace, add, or remove labels on the live session issue.

- `labels` (optional): replace all labels with this array.
- `addLabels` (optional): labels to add.
- `removeLabels` (optional): labels to remove.

### `github_update_issue`

Update the live session issue `title`, `body`, `state`, `labels`, and/or `assignees`. At least one field is required.

### `github_fetch_pr`

Read the PR associated with the session (metadata + issue-style comments).

- `pr_number` (optional): an in-scope PR number; defaults to the session's linked PR (or the open PR on the session branch).
- `include_comments` (optional, default `true`).

The tool renders the PR body, branch, state, and comments into the model-visible text content (not just the title). The full structured payload is also attached to the tool result `details` for logs/UI.

### `github_set_pr_comment`

Add a comment to the associated PR.

- `body` (required): comment text (Markdown supported).
- `pr_number` (optional): an in-scope PR number.

### `github_update_pr`

Update the associated PR `title`, `body`, `state`, and/or `labels`. Does not merge or create PRs. At least one field is required.

- `pr_number` (optional): an in-scope PR number.

### `github_list_pr_review_comments`

Read code review comments on the associated PR.

- `pr_number` (optional): an in-scope PR number.

### `github_update_main_from_origin`

Ask the control plane to refresh the session repository's effective default branch (commonly `main`) from origin in the control-plane bare repo. The worker never receives `GITHUB_TOKEN` and never runs git directly; the control plane performs the fetch + local ref update on the worker's behalf.

No parameters. The target is always the live session's `owner`/`repo`, and the branch is the effective default branch resolved by the workspace layer (per-repo override, else the global `defaultBranch`, else `main`).

Response `data`:

```json
{ "branch": "main", "before": "<sha>|null", "after": "<sha>", "updated": true }
```

`before` is the previous SHA of the local default-branch ref (or `null` if it did not exist); `after` is the current `origin/{effectiveDefaultBranch}` SHA. `updated` is `true` when `before !== after`.

Scoping: this tool never accepts `owner`/`repo`/`branch` parameters and cannot touch another repository. Missing-remote-branch and fetch failures are returned as ordinary gateway errors (`ok: false`, descriptive `error`, no `scopeError`). The operation only fast-forwards the local default-branch ref; it never rewrites `origin/{defaultBranch}` or modifies the session worktree branch `yeetomatic/issue-{n}`.

## Removed worker tools

The following tools are intentionally **not** exposed to the worker because they cannot be scoped to the current issue:

- `github_query_issues` (cross-repo / arbitrary issue discovery)
- `github_assigned_open_issues` (cross-repo discovery)
- The token-probe form of `github_get_authenticated_user` (the worker no longer probes a local token)

`github_get_authenticated_user` remains, but is served by the control-plane gateway rather than acting as a worker-side token probe.

## Error handling

Gateway failures are returned in the `details.error` field. Common cases:

- `GitHub scope error: pr_number N is not associated with session ...` — the request targeted an out-of-scope PR.
- `GitHub gateway error: ...` — a GitHub API error or validation failure.
- `GitHub gateway transport is not available; cannot call ... outside a worker session` — the extension was loaded outside a worker session (no transport installed).

## Direct (non-worker) usage

This extension is designed for the worker/gateway path. It no longer reads `GITHUB_TOKEN` from the environment or a `.env` file, and it does not build an Octokit instance. To use GitHub tools from a non-worker pi process, run them where the control plane is reachable; outside a worker session, `callGitHubGateway` throws because no transport is installed.
