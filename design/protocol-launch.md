# Protocol: Session Launch

## Purpose

This protocol defines how TARS starts a worker container for one issue session and exposes the session socket endpoint.

## Design Choice

Keep launch input simple:

- repository content is provided through a single bind mount
- session metadata is not pushed through stdin
- the worker receives launch configuration from TARS after opening the session socket
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
  --network bridge \
  -v /app/workspaces:/workspaces \
  -v /app/sessions/runtime/github-mbrooks-tars-issue-395:/tars-runtime \
  -e TARS_PRIMARY_WORKTREE=/workspaces/mbrooks-tars/.worktrees/issue-395 \
  -e TARS_SESSION_KEY=mbrooks/tars#395 \
  -e TARS_SESSION_SOCKET_PATH=/tars-runtime/session.sock \
  -e PI_AGENT_PROVIDER=ollama \
  -e PI_AGENT_MODEL=glm-5.2:cloud \
  -e OLLAMA_HOST=http://host.docker.internal:11434 \
  tars-worker:latest
```

Notes:

- No GitHub credentials are injected.
- No Docker socket is mounted.
- No session or memory volumes are mounted.
- No long-lived LLM session directory is mounted into the worker.
- The worker model is passed explicitly in the container env using `PI_AGENT_PROVIDER` and `PI_AGENT_MODEL`.
- This does not hide secret files that already live under `/app/workspaces`; those remain visible through the single bind mount.

## Runtime Mount

The runtime mount exists only to make the Unix socket available to the worker.

Example:

- host: `/app/sessions/runtime/github-mbrooks-tars-issue-395`
- container: `/tars-runtime`
- socket: `/tars-runtime/session.sock`

TARS should create and remove this directory as part of session lifecycle management.

## Launch Validation

Before launching, TARS should validate:

- the primary worktree exists
- the primary worktree path is under the mounted workspace root
- the runtime directory exists and is writable
- the Unix socket path does not already exist
- the session is not already terminal
- the container image exists or can be built

If validation fails, TARS should not start the worker and should handle the failure through existing session reporting.

## Launch Handshake

The launch handshake is:

1. TARS allocates a dedicated per-session runtime directory and socket path.
2. TARS binds the session server to the Unix socket.
3. TARS launches the worker container with socket path and session key env vars.
4. The worker connects and sends `hello`.
5. TARS validates that the session key matches the session assigned to that socket.
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

The worker container itself is always fresh. The next launch gets its own fresh per-session socket and repeats the handshake.
