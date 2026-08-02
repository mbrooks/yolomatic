<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/yeetomatic-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/yeetomatic-logo-light.png">
    <img src="assets/yeetomatic-logo-light.png" alt="Yeetomatic logo" width="280">
  </picture>

  <h1>Yeetomatic</h1>
  <p><strong>Task Automation &amp; Response System</strong></p>
</div>

Yeetomatic is a self-hosted coding agent that turns GitHub issues into pull requests with isolated execution and protected credentials.

Assign an issue to Yeetomatic and Yeetomatic creates an isolated worktree, launches a disposable coding-agent worker, and carries the task through design, implementation, feedback, and PR delivery.

## Features

- **Issue refinement** — project collaborators can run `/yeetomatic issue-refinement` to launch a disposable worker that investigates a new issue and replaces its body with a more complete Proposed Task, without starting implementation.
- **Issue-to-PR automation** — creates a `yeetomatic/issue-{number}` branch, commits the result, pushes it, and opens a linked pull request.
- **GitHub-native collaboration** — responds to issue updates, comments, PR reviews, and inline review comments.
- **Multi-repository support** — manages each repository, worktree, and issue session independently.
- **Admin dashboard** — configure repositories and models, start and control sessions, manage skills, and inspect live logs.
- **Webhook or polling events** — use a public webhook endpoint, GitHub polling, or both.
- **Persistent sessions** — stores settings, session state, and logs in SQLite and resumes interrupted work after restarts.
- **Isolated workers** — runs each agent execution in a disposable Docker container without GitHub credentials or access to the Docker socket.

## Install

### Requirements

- Docker Engine or Docker Desktop with Docker Compose (not currently compatible with Kubernetes but PRs welcome!)
- A GitHub personal access token that can read and modify the repositories Yeetomatic will manage

### Start Yeetomatic

```bash
git clone https://github.com/mbrooks/yeetomatic.git
cd yeetomatic
cp .env.example .env
docker compose up --build -d
```

Open [http://127.0.0.1:6767/yeetomatic/admin](http://127.0.0.1:6767/yeetomatic/admin) and complete the setup wizard. It will:

1. Create admin credentials.
2. Verify your GitHub token.
3. Generate a webhook secret.
4. Select repositories and initialize their workspaces.

Follow the logs with:

```bash
docker compose logs -f yeetomatic
```

Stop Yeetomatic with:

```bash
docker compose down
```

Yeetomatic persists its settings, sessions, workspaces, agent configuration, and runtime data in Docker volumes.

To rerun the onboarding wizard without deleting existing settings, open
**Settings**, click **Rerun On-Boarding** button, and confirm
the action.

To force the wizard to run from the command line instead:

```bash
docker compose exec -T yeetomatic npm run onboarding:reset
```

Refresh `/yeetomatic/admin` after the command completes. Restart Yeetomatic as well if you
want it to start in onboarding-only mode:

```bash
docker compose restart yeetomatic
```

To dump every effective configuration value using the same
database-over-environment-over-default precedence as Yeetomatic:

```bash
docker compose exec -T yeetomatic npm run config:dump
```

The output includes all values, including tokens, passwords, and webhook
secrets. Treat it as secret material.

## Connect GitHub

Yeetomatic can receive repository activity by webhook, polling, or both. Choose the global mode under **Settings → GitHub Integration**, or override it for an individual repository.

### Webhook

Expose port `6767` through HTTPS, then create a GitHub repository webhook with:

- **Payload URL:** `https://your-host.example/webhook`
- **Content type:** `application/json`
- **Secret:** the secret generated during setup
- **Events:** issues, issue comments, pull request reviews, and pull request review comments

For local testing, a tunnel such as `ngrok http 6767` can provide the public URL.

### Polling

Select `polling` if Yeetomatic cannot receive a public webhook. No public URL is required. The default polling interval is 60 seconds.

## Usage

1. Add a repository in the setup wizard or the **Repositories** screen.
2. Open an issue with a clear description and acceptance criteria.
3. Assign the issue to the GitHub account connected to Yeetomatic, or choose **Start Session** from the issue in the admin dashboard.
4. Follow progress in GitHub or inspect the live session log in the dashboard.
5. Add an issue comment or update the issue description to steer active work. Yeetomatic keeps the same issue session and worktree.
6. Review the pull request. Actionable review comments trigger another implementation pass and are pushed to the same branch.

Yeetomatic uses workflow labels and GitHub comments to show its current state:

| Label | Meaning |
| --- | --- |
| `yeetomatic-working` | The issue is being processed. |
| `yeetomatic-feedback-required` | Yeetomatic needs more information. |
| `yeetomatic-pr-created` | The implementation has been pushed and a PR is ready. |
| `yeetomatic-failed` | The agent run failed. |
| `yeetomatic-cancelled` | The session was stopped. |

The configured admin GitHub user can stop an issue from GitHub by commenting:

```text
/yeetomatic stop
```

## Issue Refinement

An authorized maintainer can ask Yeetomatic to investigate a newly opened issue and replace its body with a more complete Proposed Task. When an eligible issue is opened, Yeetomatic posts a static comment explaining the command. To start refinement, comment exactly:

```text
/yeetomatic issue-refinement
```

Refinement launches the same disposable Docker worker used for implementation, but in a temporary worktree. The worker may inspect the repository, make experimental edits, run the application and tests, and use the network. When it succeeds, Yeetomatic automatically replaces the issue body with the returned Proposed Task; the title, implementation session, and PR workflow remain untouched. The original body and refinement provenance are stored in the refinement history for audit and recovery.

Refinement behavior can be customized by adding `.pi/skills/issue-refinement/SKILL.md` to the target repository. If the skill is missing, Yeetomatic falls back to built-in prompt defaults. A present skill that cannot be read or executed produces a failed refinement attempt rather than silently switching instructions.

Refinement and implementation cannot overlap on the same issue, and refinement never commits, pushes, or opens a pull request.

Sessions can also be paused, resumed, restarted, archived, or deleted from the admin dashboard when their current state permits it.

## How It Works

Yeetomatic is the control plane: it receives GitHub events, manages repositories and session state, and performs GitHub delivery. Each agent run happens in a separate, disposable worker container that edits the shared issue worktree and streams its activity back to Yeetomatic over a WebSocket session.

The diagram below shows the high-level request and event flow. The **Yeetomatic control plane** owns everything deterministic — event intake, session and workspace state, delivery — while **worker execution** is isolated in a disposable container with no GitHub credentials and no Docker socket access.

```mermaid
flowchart TD
    subgraph External["GitHub & users"]
        User["Issue / PR author"]
        Admin["Admin user"]
        GH["GitHub repository"]
    end

    subgraph ControlPlane["Yeetomatic control plane — yeetomatic container"]
        direction TB
        WebUI["Admin dashboard<br/>port 6767"]
        Webhook["Webhook endpoint<br/>/webhook"]
        Poll["GitHub polling adapter"]
        Session["Session & workspace manager"]
        DB[("SQLite state & logs")]
        Delivery["Delivery — commit, push, PR"]
    end

    subgraph WorkerExec["Worker execution — disposable container"]
        Worker["Agent runtime (pi)"]
        WS["WebSocket session"]
        Provider["Configured LLM provider"]
    end

    subgraph Storage["Repositories & worktrees"]
        Bare[("Bare repo")]
        WT["Per-issue worktree"]
    end

    User -->|"assign / comment / review"| GH
    Admin -->|"start / steer / stop"| WebUI
    GH -->|"issues, comments, reviews"| Webhook
    GH -.->|"poll (fallback)"| Poll
    Webhook --> Session
    Poll --> Session
    WebUI --> Session
    Session --> DB
    Session -->|"create / reuse"| Bare
    Bare -->|"git worktree add"| WT
    Session -->|"launch + session token"| Worker
    Worker -->|"connect"| WS
    WS <-->|"events / steering / stop"| Session
    Worker -->|"read / write code"| WT
    Worker -->|"tool calls"| Provider
    Provider -->|"responses"| Worker
    Session --> Delivery
    Delivery -->|"commit / push branch"| Bare
    Delivery -->|"create / update PR, labels, comments"| GH
    GH -->|"notifications"| User
```

Legend:

- **Solid arrows** are primary flows; **dotted arrows** are optional fallbacks (polling).
- The control plane handles event intake, session and worktree lifecycle, and GitHub delivery. It owns GitHub credentials and persistent state.
- The worker handles agent execution only — it edits the issue worktree, calls the configured LLM provider, and streams activity back over a single session-scoped WebSocket connection. It has no GitHub credentials and no Docker socket access.

See [design/README.md](design/README.md) for the worker architecture and protocol.

## Development

```bash
npm ci
npm run build
npm run guardrail:test
```

Useful commands:

```bash
npm run dev          # watch the server
npm run dev:admin    # run the admin UI with Vite
npm test             # run unit tests
```

Running agent sessions still requires Docker because Yeetomatic executes coding work in worker containers.

## Operations

- [WORKSPACES.md](WORKSPACES.md) — repository checkout and worktree conventions
- [CRON.md](CRON.md) — automatic deployment updates
- [MIGRATIONS.md](MIGRATIONS.md) — SQLite migration management
- [CHANGELOG.md](CHANGELOG.md) — release changes

Yeetomatic writes application and agent logs to standard output. In Docker, use `docker compose logs` rather than looking for log files.
