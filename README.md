# pi-coding-agent

Webhook-driven GitHub issue worker for `mbrooks/*` repositories.

## Features

- Receives `issues`, `issue_comment`, `pull_request_review_comment`, and `pull_request_review` GitHub webhooks in real time
- Maintains one persistent pi session per issue at `SESSIONS_DIR/github-{owner}-{repo}/issue-{number}.jsonl`
- Keeps repository work isolated under `WORKSPACES_DIR/{owner}-{repo}`
- Applies workflow labels: `tars-working`, `tars-feedback-required`, `tars-pr-created`, `tars-complete`
- Posts issue comments at pickup, feedback resume, clarification, and completion
- Accepts `issue_comment` on any TARS-labeled issue (not just feedback-blocked)
- Ignores bot comments, including its own
- Commits, pushes branch, and labels `tars-pr-created` when work is complete

## Setup

### Quickstart: Docker Compose

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Start TARS:
   ```bash
   docker compose up --build
   ```
3. Open the admin wizard at:
   ```
   http://127.0.0.1:6767/tarsadmin
   ```
4. Use the wizard to create admin credentials, verify a GitHub token, generate a webhook secret, and initialize repositories.
5. Configure each GitHub repository webhook with payload URL `https://your-public-host/webhook` and the generated secret.

For local testing, expose port `6767` with a tunnel such as `ngrok http 6767`, then use the tunnel `/webhook` URL in GitHub.

### Quickstart: Local npm

1. Install dependencies: `npm install`
2. Start the receiver with `npm run dev`
3. Open the admin wizard at `http://127.0.0.1:6767/tarsadmin`
4. Complete the same setup flow: admin credentials, GitHub token verification, webhook secret, and optional workspace initialization.
5. Expose the local server if needed, for example `ngrok http 6767`, and point the GitHub webhook to `POST /webhook`.

### Troubleshooting First Run

| Symptom | Check |
| --- | --- |
| Admin UI shows onboarding every time | Ensure the `MEMORY_DIR` volume or local `./memory` directory is persisted. |
| GitHub token verification fails | Confirm the token is active and can access the target repositories and issues. |
| Webhook returns `401 Invalid signature` | The GitHub webhook secret must match the generated TARS secret exactly. |
| No webhook deliveries arrive | Confirm the public payload URL ends in `/webhook` and reaches port `6767`. |
| Repository initialization fails | Confirm the token can clone the repo and that the workspace directory is writable. |
| Agent starts but cannot run model work | Check `PI_AGENT_PROVIDER`, `PI_AGENT_MODEL`, `TARS_WORKER_NETWORK_MODE`, and the Ollama sidecar/container logs. |

### Docker Deployment

TARS can be deployed with Docker Compose, including an Ollama sidecar.

1. Create `.env` from `.env.example`:
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

2. Build and run:
   ```bash
   docker compose up --build -d
   ```

3. View logs (console only):
   ```bash
   docker logs -f tars
   docker logs -f tars-ollama
   ```

4. Point GitHub webhook to:
   ```
   http://your-host:6767/webhook
   ```

#### Docker Environment Variables

```env
GITHUB_USERNAME=mbrooks
GITHUB_TOKEN=ghp_your_actual_token
WEBHOOK_SECRET=your_actual_secret
SESSIONS_DIR=/app/sessions
WORKSPACES_DIR=/app/workspaces
DEFAULT_BRANCH=main
MAX_WORKTREES=10
WORKTREE_EVICTION_STRATEGY=lru
AUTO_START=true
PORT=6767
NODE_ENV=production
```

Compose also injects `OLLAMA_HOST=http://127.0.0.1:11434` for the control plane and launches workers with `TARS_WORKER_NETWORK_MODE=container:tars` plus `TARS_WORKER_OLLAMA_HOST=http://127.0.0.1:11434` so disposable workers can reach the same Ollama sidecar over the shared network namespace.

#### Docker Services

| Service | Description |
|---------|-------------|
| `tars` | TARS webhook receiver on port `6767` |
| `ollama` | Ollama LLM service on port `11434` |

#### Docker Volumes

| Volume | Container Path | Purpose |
|--------|---------------|---------|
| `tars_sessions` | `/app/sessions` | Session files (pi jsonl + state) |
| `tars_workspaces` | `/app/workspaces` | Repo checkouts + git worktrees |
| `tars_pi` | `/home/tars/.pi/agent` | Pi config, settings, extensions |

Ollama model data is mounted from the host at `${HOME}/.ollama` so the sidecar reuses the same local model cache as `../case`.

#### Webhook URL with Docker

```
# Expose port from host
http://your-host:6767/webhook

# With reverse proxy (nginx)
https://tars.example.com/webhook
```

Configure the GitHub webhook payload URL to point to your Docker host.

#### NGINX Reverse Proxy (Production)

```nginx
server {
    listen 443 ssl;
    server_name tars.example.com;

    location /webhook {
        proxy_pass http://localhost:6767/webhook;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

#### Docker Commands

```bash
# Build
docker-compose build

# Run
docker-compose up -d

# Check running
docker-compose ps

# View logs (console only — no log files)
docker logs -f tars

# View Ollama logs
docker logs -f tars-ollama

# Restart
docker-compose restart tars

# Stop
docker-compose down

# Test webhook (from host)
curl -X POST http://localhost:6767/webhook \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: ping" \
  -d '{"zen":"Ping!"}'

# Test Ollama (from container)
docker exec tars curl http://127.0.0.1:11434/api/tags
```

#### Log Strategy: Console Only

TARS logs all LLM output, webhook events, and executor status to **stdout** — no log files, no log volumes. Docker captures stdout, accessible via `docker logs -f tars`.

### Auto-Update (Cron)

For production deployments, wire `scripts/update-tars-if-needed.sh` into cron to poll for upstream changes every 15 minutes. See [CRON.md](CRON.md) for install instructions.

## Flow

1. `issues.opened` creates or loads `sessions/github-{owner}-{repo}/issue-{number}.jsonl`.
2. If `AUTO_START=true`, TARS labels the issue `tars-working`, comments, and executes in the repo workspace.
3. If the agent responds with `TARS_STATUS: waiting-feedback`, TARS switches the issue to `tars-feedback-required`.
4. When `issue_comment.created` arrives on any TARS-labeled issue, TARS resumes the same session (ignores bot comments).
5. When `pull_request_review_comment.created` or `pull_request_review.submitted` arrives on a TARS PR, TARS iterates on the code and pushes updates to the PR branch.
6. If the agent responds with `TARS_STATUS: complete`, TARS commits changes, pushes the branch, adds `tars-pr-created`, and posts a completion summary.

## Notes

- TARS commits, pushes, and creates the PR from the host process after the agent reports `TARS_STATUS: complete`.
- Multi-repo support is native: webhook payloads provide owner and repo, and both workspace and session paths are derived from that data.
- See [WORKSPACES.md](WORKSPACES.md) for workspace checkout rules.
