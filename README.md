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

### Local Development

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env`
3. Fill in GitHub credentials, `WEBHOOK_SECRET`, and PI agent auth
4. Run the receiver with `npm run dev`
5. Expose the local server if needed, for example `ngrok http 3000`
6. Point the GitHub webhook to `POST /webhook`

### Docker Deployment

TARS can be deployed with Docker Compose, including an Ollama sidecar.

1. Create `.env` from `.env.example`:
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

2. Build and run:
   ```bash
   docker-compose up --build -d
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
AUTO_START=true
PORT=6767
NODE_ENV=production
```

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
| `tars_ollama` | `/root/.ollama` | Ollama model data |

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
docker exec tars curl http://ollama:11434/api/tags
```

#### Log Strategy: Console Only

TARS logs all LLM output, webhook events, and executor status to **stdout** — no log files, no log volumes. Docker captures stdout, accessible via `docker logs -f tars`.

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
