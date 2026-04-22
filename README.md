# pi-coding-agent

Webhook-driven GitHub issue worker for `mbrooks/*` repositories.

## Features

- Receives `issues` and `issue_comment` GitHub webhooks in real time
- Maintains one persistent pi session per issue at `SESSIONS_DIR/{repo}-issue-{number}.jsonl`
- Keeps repository work isolated under `WORKSPACES_DIR/{owner}-{repo}`
- Applies workflow labels: `tars-working`, `tars-feedback-required`, `tars-pr-created`, `tars-complete`
- Posts issue comments at pickup, feedback resume, clarification, and completion
- Accepts `issue_comment` on any TARS-labeled issue (not just feedback-blocked)
- Ignores bot comments, including its own
- Commits, pushes branch, and labels `tars-pr-created` when work is complete

## Setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env`
3. Fill in GitHub credentials, `WEBHOOK_SECRET`, and PI agent auth
4. Run the receiver with `npm run dev`
5. Expose the local server if needed, for example `ngrok http 3000`
6. Point the GitHub webhook to `POST /webhook`

## Flow

1. `issues.opened` creates or loads `sessions/{repo}-issue-{number}.jsonl`.
2. If `AUTO_START=true`, TARS labels the issue `tars-working`, comments, and executes in the repo workspace.
3. If the agent responds with `TARS_STATUS: waiting-feedback`, TARS switches the issue to `tars-feedback-required`.
4. When `issue_comment.created` arrives on any TARS-labeled issue, TARS resumes the same session (ignores bot comments).
5. If the agent responds with `TARS_STATUS: complete`, TARS commits changes, pushes the branch, adds `tars-pr-created`, and posts a completion summary.

## Notes

- PR creation is intentionally disabled.
- Multi-repo support is native: webhook payloads provide owner and repo, and both workspace and session paths are derived from that data.
- See [WORKSPACES.md](WORKSPACES.md) for workspace checkout rules.
