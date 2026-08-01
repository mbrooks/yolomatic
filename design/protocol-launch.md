# Protocol: Session Launch

Status: as-built design

Last verified: 2026-08-01 against `github/main` at `26171605efdd`

## Purpose

This protocol defines how Yeetomatic starts a worker container for one issue session and exposes the worker session URL.

## Design Choice

Keep launch input simple:

- repository content is provided through a single workspace mount
- session metadata is not pushed through stdin
- the worker receives launch configuration from Yeetomatic after opening the worker session WebSocket
- cancellation requests a graceful agent abort and has a `docker stop`
  fallback

This keeps the authoritative control surface in one place: the session server hosted by Yeetomatic.

## Worker Image

The worker image is a Debian-based image built for agent execution. It contains:

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
  --name yeetomatic-session-mbrooks-yeetomatic-395 \
  --network container:yeetomatic \
  --mount type=volume,src=yeetomatic_workspaces,dst=/app/workspaces \
  -e YEETOMATIC_SESSION_KEY=mbrooks/yeetomatic#395 \
  -e YEETOMATIC_SESSION_WS_URL=ws://127.0.0.1:6767/yeetomatic-worker/ws?sessionKey=mbrooks%2Fyeetomatic%23395&token=<opaque-token> \
  -e YEETOMATIC_SOUL_PATH=/app/SOUL.md \
  -e PI_AGENT_PROVIDER=ollama \
  -e PI_AGENT_MODEL=glm-5.2:cloud \
  -e OLLAMA_HOST=http://127.0.0.1:11434 \
  yeetomatic-worker:latest
```

Notes:

- No GitHub credentials are injected.
- No Docker socket is mounted.
- No control-plane session, runtime, memory, or Pi-agent volumes are mounted.
- No long-lived LLM session directory is mounted into the worker.
- The primary worktree is delivered in `launch_config`, not through a dedicated environment variable.
- The worker model is passed explicitly in the container env using `PI_AGENT_PROVIDER` and `PI_AGENT_MODEL`.
- This does not hide secret files that already live under `/app/workspaces`; those remain visible through the workspace mount.
- The worker mount target must match the control plane's `WORKSPACES_DIR` exactly so git worktree metadata resolves in both containers.

## Workspace Mount Resolution

`worker_workspace_mount_source` can name either a host path or a Docker volume:

- an absolute source becomes a bind mount
- a non-absolute source becomes a Docker volume mount
- when Yeetomatic itself runs in a container and `HOSTNAME` is available, it
  inspects that container and reuses the actual volume name or bind source
  mounted at `WORKSPACES_DIR`
- if self-inspection is unavailable, it falls back to the configured source

The resolved source is cached for the life of the executor. Only the workspace
mount is passed to workers.

Compose still provisions `/app/runtime` on the control plane and defines the
legacy `YEETOMATIC_WORKER_RUNTIME_*` environment variables. The current config
and Docker worker executor do not read those variables or pass that volume to
workers; worker RPC uses WebSocket instead.

## Session URL

The session URL exists only for the lifetime of one active worker run.

Example:

- `ws://127.0.0.1:6767/yeetomatic-worker/ws?sessionKey=mbrooks%2Fyeetomatic%23395&token=<opaque-token>`

For non-compose deployments, the base URL may instead point at `host.docker.internal` or another worker-reachable control-plane address. The key requirement is that the value matches the worker container's network perspective.

The connection token is a random, single-use pending reservation. The upgrade
must provide both the matching token and session key; otherwise the server
returns `401 Unauthorized`. The token is removed before the connection is
accepted and the reservation is disposed when the launch attempt ends.

## Network and Ollama Resolution

When `worker_docker_network_mode` starts with `container:`, the worker joins
that container's network namespace. Compose uses `container:yeetomatic`, so the
control plane and Ollama are available to the worker on loopback.

For other network modes, Yeetomatic adds the Docker host-gateway alias for
`host.docker.internal`. An explicit `worker_ollama_host` is forwarded unchanged.
Otherwise, a control-plane `OLLAMA_HOST` using `127.0.0.1` or `localhost` is
rewritten to `host.docker.internal` unless container-network sharing is active.

## Launch Validation

Before launching a container, Yeetomatic:

1. builds the worker image once for the current control-plane process
2. resolves the primary worktree path under `WORKSPACES_DIR`
3. verifies the primary worktree exists
4. rejects an `origin` URL containing embedded credentials
5. creates a session URL from the configured control base URL

If any step fails, Yeetomatic does not start that launch attempt and existing
session reporting handles the error. A rejected image-build promise remains
shared for that executor, so another image build is not attempted until the
control-plane process restarts.

## Launch Handshake

The launch handshake is:

1. Yeetomatic allocates a dedicated per-session token and WebSocket reservation.
2. Yeetomatic launches the worker container with session URL and session key env vars.
3. The worker connects and sends `hello`.
4. Yeetomatic validates that the session key matches the reserved session.
5. Yeetomatic replies with `launch_config` and waits for its acknowledgement.
6. The worker acknowledges and begins execution.

## Launch Payload

The `launch_config` message envelope contains the protocol version and session
key. Its payload contains:

- owner
- repo
- issue number
- primary workspace path
- title
- body
- optional session tag
- prompt kind
- prompt text
- optional limits

This replaces stdin as the source of truth for launch configuration.

The worker launch passes model selection in the container environment when configured, for example:

- `PI_AGENT_PROVIDER=ollama`
- `PI_AGENT_MODEL=glm-5.2:cloud`

The session protocol does not carry model selection. Model choice belongs to worker process configuration at launch time.

The host currently sends `limits.maxRuntimeSeconds: 7200`, but neither the host
nor worker enforces that value as a runtime deadline.

## Container Naming and Conflict Recovery

The worker name is deterministic:

- `yeetomatic-session-{owner}-{repo}-{issueNumber}`

Characters outside Docker's accepted name set are replaced with `-`. A Docker
name conflict triggers guarded recovery:

1. inspect the conflicting container state
2. remove it only when the state is `created`, `dead`, or `exited`
3. retry launch with a new WebSocket reservation

Yeetomatic allows three recovered retries after the first attempt. It does not
remove a running container, a container whose state cannot be inspected, or a
stopped container that Docker cannot remove.

Workers are launched without a Docker restart policy. There is no adoption or
reconciliation path after a control-plane restart, so a still-running
same-session container is treated as a running name conflict and preserved.

## Cancellation

Yeetomatic may cancel a session in two ways:

1. graceful:
   - send `control` with `action: "stop"`
   - wait for the worker acknowledgement; the worker acknowledges before
     aborting the active agent
2. forced fallback:
   - after that acknowledgement succeeds or sending it fails, arm a five-second
     timer that sends `docker stop`

The control message path is attempted first because it gives the worker a chance to stop the agent cleanly. `docker kill` escalation is not currently implemented.

The current host has no acknowledgement timeout. If the connection remains open
but the worker never acknowledges the stop message, the `docker stop` timer is
not armed. This is a known gap in the forced-fallback path.

## Resume

Resume is implemented as a new worker launch against the same session state.

The worker container itself is always fresh. The next launch gets its own fresh per-session WebSocket reservation and repeats the handshake.
