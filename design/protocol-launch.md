# Protocol: Session Launch

## Purpose

This protocol defines how TARS starts a worker container for one issue session and exposes the worker session URL.

## Design Choice

Keep launch input simple:

- repository content is provided through a single bind mount
- session metadata is not pushed through stdin
- the worker receives launch configuration from TARS after opening the worker session WebSocket
- cancellation is process-level: TARS stops the container

This keeps the authoritative control surface in one place: the session server hosted by TARS.

## Worker Image

The worker image is a clean Debian-based image built for agent execution. It should contain:

- Node.js
- the agent runtime and TARS worker entrypoint
- git
- common shell tools

The worker starts as root so it can run `apt-get` during the session.

## Docker Run Shape

Illustrative command:

```bash
docker run --rm \
  --name tars-session-mbrooks-tars-395 \
  --network container:tars \
  -v /app/workspaces:/workspaces \
  -e TARS_PRIMARY_WORKTREE=/workspaces/mbrooks-tars/.worktrees/issue-395 \
  -e TARS_SESSION_KEY=mbrooks/tars#395 \
  -e TARS_SESSION_WS_URL=ws://127.0.0.1:6767/tars-worker/ws?sessionKey=mbrooks%2Ftars%23395&token=<opaque-token> \
  -e PI_AGENT_PROVIDER=ollama \
  -e PI_AGENT_MODEL=glm-5.2:cloud \
  -e OLLAMA_HOST=http://127.0.0.1:11434 \
  tars-worker:latest
```

Notes:

- No GitHub credentials are injected.
- No Docker socket is mounted.
- No session or memory volumes are mounted.
- No long-lived LLM session directory is mounted into the worker.
- The worker model is passed explicitly in the container env using `PI_AGENT_PROVIDER` and `PI_AGENT_MODEL`.
- This does not hide secret files that already live under `/app/workspaces`; those remain visible through the single bind mount.

## Session URL

The session URL exists only for the lifetime of one active worker run.

Example:

- `ws://127.0.0.1:6767/tars-worker/ws?sessionKey=mbrooks%2Ftars%23395&token=<opaque-token>`

For non-compose deployments, the base URL may instead point at `host.docker.internal` or another worker-reachable control-plane address. The key requirement is that the value matches the worker container's network perspective.

TARS should create and remove the underlying pending reservation as part of session lifecycle management.

## Launch Validation

Before launching, TARS should validate:

- the primary worktree exists
- the primary worktree path is under the mounted workspace root
- the worker control base URL is configured correctly for the worker's network perspective
- the session is not already terminal
- the container image exists or can be built

If validation fails, TARS should not start the worker and should handle the failure through existing session reporting.

## Launch Handshake

The launch handshake is:

1. TARS allocates a dedicated per-session token and WebSocket reservation.
2. TARS launches the worker container with session URL and session key env vars.
4. The worker connects and sends `hello`.
5. TARS validates that the session key matches the reserved session.
6. TARS replies with `launch_config`.
7. The worker acknowledges and begins execution.

## Launch Payload

The `launch_config` payload should contain:

- protocol version
- owner
- repo
- issue number
- session key
- primary workspace path
- title
- body
- prompt kind
- prompt text
- optional limits

This replaces stdin as the source of truth for launch configuration.

The worker launch should still pass the model in the container env as well, for example:

- `PI_AGENT_PROVIDER=ollama`
- `PI_AGENT_MODEL=glm-5.2:cloud`

The session protocol should not carry model selection. Model choice belongs to worker process configuration at launch time.

## Cancellation

TARS may cancel a session in two ways:

1. graceful:
   - send `control` with `action: "stop"`
   - wait for worker acknowledgement and terminal completion
2. forced:
   - send `docker stop`
   - if needed, escalate to `docker kill`

The control message path should be preferred first because it gives the worker a chance to stop the agent cleanly.

## Resume

Resume is implemented as a new worker launch against the same session state.

The worker container itself is always fresh. The next launch gets its own fresh per-session WebSocket reservation and repeats the handshake.
