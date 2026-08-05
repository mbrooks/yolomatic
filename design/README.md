# Design Documentation

This folder describes the GitHub workflow and worker-session runtime currently
implemented by Yeetomatic, plus explicitly labeled proposed extensions:

- Yeetomatic remains the deterministic control plane.
- A disposable worker container runs the full LLM agent for each issue execution.
- The worker can read and write any repository under the shared workspace mount.
- The worker has no GitHub credentials, no Docker socket, and no direct access to Yeetomatic state.
- Yeetomatic and the worker communicate through a bidirectional session protocol over a WebSocket connection.

## Documents

- [github-workflow.md](github-workflow.md): end-to-end GitHub event, issue,
  feedback, delivery, and PR iteration workflow
- [issue-refinement.md](issue-refinement.md): proposed opt-in workflow for
  expanding a new issue with the repository's `issue-refinement` skill or
  Yeetomatic's built-in prompt defaults, reusing the disposable Docker worker
  for investigation and testing, and automatically replacing the issue body
  after an authorized `/yeetomatic issue-refinement` command
- [architecture.md](architecture.md): system overview, trust boundaries, and lifecycle
- [protocol-launch.md](protocol-launch.md): how Yeetomatic starts a worker session and exposes the worker session URL
- [protocol-websocket-transport.md](protocol-websocket-transport.md): transport, session isolation, reconnect, and shutdown rules
- [protocol-session-messages.md](protocol-session-messages.md): bidirectional message types for launch, events, heartbeat, steering, and completion
- [schema.md](schema.md): SQLite tables, columns, indexes, and persistence conventions used by the control plane
- [worker-env-init.md](worker-env-init.md): proposed design for deterministically running a repository-provided `.pi/init.sh` in the worker container before the agent starts

## Goals

- Keep orchestration, repo management, push, and PR delivery in Yeetomatic.
- Run the agent in an isolated, disposable Debian worker container.
- Support live steering and stop semantics over one session connection.
- In Docker Compose deployments, let workers share the Yeetomatic container network namespace so they reach Yeetomatic and Ollama over `127.0.0.1` instead of a host-published port.
- Keep `WORKSPACES_DIR` identical in the control plane and worker so git worktree metadata stays valid without path rewriting.
- Keep the first implementation simple:
  - one worker per execution attempt
  - one read-write mount for the full workspace tree
  - internet access enabled
  - one session-scoped WebSocket connection
  - no MCP dependency

## Current Scope and Non-Goals

- Egress filtering
- Fine-grained per-repo mount isolation
- In-worker GitHub operations
- Persistent tool caches across worker sessions
- Host-side tool exposure through MCP
- Multi-worker coordination for one session

## Current Limitations

- `pause` exists in the protocol type but currently aborts execution in the same way as `stop`; resumable pause semantics are not implemented.
- Event batches currently contain canonical `session_log` entries rather than separate assistant, reasoning, and tool event variants.
- A disconnect fails the execution. Resumption launches a new worker and
  WebSocket reservation; an interrupted connection is not resumed in place.
- The worker image is rebuilt once per control-plane process so deployments use current source; Docker reuses unchanged build layers. The container is fresh for each execution.
- Worker names are deterministic. Name-conflict recovery removes and retries
  only stopped containers; running or uninspectable conflicts fail closed.
- Workers have no Docker restart policy or reconciliation/adoption loop. A
  worker still running after a control-plane restart blocks a same-session
  relaunch until it exits or is handled outside the executor.
- Stop requests rely on a control acknowledgement before arming the five-second
  `docker stop` fallback. A missing acknowledgement currently has no timeout.
- Heartbeats update activity and `maxRuntimeSeconds` is sent in launch config,
  but neither is enforced as a worker-protocol watchdog or runtime deadline.
