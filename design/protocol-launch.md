# Protocol: Session Launch

## Purpose

This protocol defines how Yeetomatic starts a worker container for one issue session and exposes the worker session URL.

## Design Choice

Keep launch input simple:

- repository content is provided through a single bind mount
- session metadata is not pushed through stdin
- the worker receives launch configuration from Yeetomatic after opening the worker session WebSocket
- cancellation is process-level: Yeetomatic stops the container

This keeps the authoritative control surface in one place: the session server hosted by Yeetomatic.

## Worker Image

The worker image is a clean Debian-based image built for agent execution. It should contain:

- Node.js
- the agent runtime and Yeetomatic worker entrypoint
- git
- common shell tools

The worker runs as the non-root `yeetomatic` user with `HOME=/home/yeetomatic` and `PI_CODING_AGENT_DIR=/home/yeetomatic/.pi/agent`. System package installation with `apt-get` is therefore not available during an ordinary worker session. Node packages and other user-writable tooling may still be installed when the workspace permits it.

Before the first worker launch in each control-plane process, Yeetomatic builds the `worker` Dockerfile target and tags it with the current WebSocket transport label. Docker reuses unchanged build layers, and subsequent launches in the same process reuse that completed image-build promise.

## Docker Run Shape

Illustrative command:

```bash
docker run --rm \
  --name yeetomatic-session-mbrooks-tars-395 \
  --network container:yeetomatic \
  --mount type=volume,src=yeetomatic_workspaces,dst=/app/workspaces \
  -e YEETOMATIC_SESSION_KEY=mbrooks/tars#395 \
  -e YEETOMATIC_SESSION_WS_URL=ws://127.0.0.1:6767/yeetomatic-worker/ws?sessionKey=mbrooks%2Ftars%23395&token=<opaque-token> \
  -e YEETOMATIC_SOUL_PATH=/app/SOUL.md \
  -e PI_AGENT_PROVIDER=ollama \
  -e PI_AGENT_MODEL=glm-5.2:cloud \
  -e OLLAMA_HOST=http://127.0.0.1:11434 \
  yeetomatic-worker:latest
```

Notes:

- No GitHub credentials are injected.
- No Docker socket is mounted.
- No session or memory volumes are mounted.
- No long-lived LLM session directory is mounted into the worker.
- The primary worktree is delivered in `launch_config`, not through a dedicated environment variable.
- The worker model is passed explicitly in the container env using `PI_AGENT_PROVIDER` and `PI_AGENT_MODEL`.
- This does not hide secret files that already live under `/app/workspaces`; those remain visible through the single bind mount.
- The worker mount target must match the control plane's `WORKSPACES_DIR` exactly so git worktree metadata resolves in both containers.

## Session URL

The session URL exists only for the lifetime of one active worker run.

Example:

- `ws://127.0.0.1:6767/yeetomatic-worker/ws?sessionKey=mbrooks%2Ftars%23395&token=<opaque-token>`

For non-compose deployments, the base URL may instead point at `host.docker.internal` or another worker-reachable control-plane address. The key requirement is that the value matches the worker container's network perspective.

Yeetomatic should create and remove the underlying pending reservation as part of session lifecycle management.

## Launch Validation

Before launching, Yeetomatic validates:

- the primary worktree exists
- the primary worktree path is under the mounted workspace root
- the worker control base URL can be converted to the session WebSocket URL
- the container image exists or can be built

If validation fails, Yeetomatic should not start the worker and should handle the failure through existing session reporting.

## Launch Handshake

The launch handshake is:

1. Yeetomatic allocates a dedicated per-session token and WebSocket reservation.
2. Yeetomatic launches the worker container with session URL and session key env vars.
4. The worker connects and sends `hello`.
5. Yeetomatic validates that the session key matches the reserved session.
6. Yeetomatic replies with `launch_config`.
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

Yeetomatic may cancel a session in two ways:

1. graceful:
   - send `control` with `action: "stop"`
   - wait for worker acknowledgement and terminal completion
2. forced fallback:
   - if the worker has not stopped after five seconds, send `docker stop`

The control message path is attempted first because it gives the worker a chance to stop the agent cleanly. `docker kill` escalation is not currently implemented.

## Resume

Resume is implemented as a new worker launch against the same session state.

The worker container itself is always fresh. The next launch gets its own fresh per-session WebSocket reservation and repeats the handshake.
