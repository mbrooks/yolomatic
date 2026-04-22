# Workspaces

TARS manages repository code in isolated per-repo workspaces.

## Directory Structure

Canonical root: `~/workspaces`

Configured root: `WORKSPACES_DIR` in `.env`

Naming convention:
- `{owner}-{repo}`
- lowercase
- hyphen-separated

Example:

```text
/workspaces/
  mbrooks-tars/
  mbrooks-casebot/
  mbrooks-case/
```

## Checkout Rules

Repositories are checked out with HTTPS auth:

```bash
git clone https://<GITHUB_USERNAME>:<GITHUB_TOKEN>@github.com/<owner>/<repo>.git
```

Required environment variables:
- `GITHUB_USERNAME`
- `GITHUB_TOKEN`
- `WORKSPACES_DIR`

TARS creates `WORKSPACES_DIR` if it does not exist.

## Branching

TARS does not work directly on `main`.

Branch rules:
- Base branch defaults to `main` unless `DEFAULT_BRANCH` is set
- Issue work happens on `tars/issue-{number}`
- Existing repositories are refreshed before branch creation

## How TARS Uses Workspaces

When an issue is picked up:

1. TARS computes the workspace key as `{owner}-{repo}`.
2. TARS clones the repo into `WORKSPACES_DIR/{owner}-{repo}` if needed.
3. If the workspace already exists, TARS fetches latest remote refs and updates the requested base branch.
4. TARS creates or resets the issue branch `tars/issue-{number}`.
5. TARS maps the issue to `SESSIONS_DIR/{repo}-issue-{number}.jsonl`.
6. TARS launches pi-agent with `cwd` set to that workspace and persists session state across webhook events.

## Isolation

Each repository gets its own directory and session metadata points to exactly one workspace. TARS should only read and write within the workspace associated with the active issue session.
