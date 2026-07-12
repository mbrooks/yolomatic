# Architecture

## Summary

TARS runs as a control plane and launches a separate worker container for each issue execution. The worker owns agent execution and code changes. TARS owns everything deterministic before and after the run.

The control plane and worker communicate through a bidirectional session protocol over a WebSocket connection. TARS hosts the server side on its existing control-plane HTTP server. The worker is the client that connects with a session-specific URL and token.

## Why This Shape

This problem needs:

- streaming session telemetry
- terminal result handoff
- server-initiated pause, stop, and steer commands
- simple local-only transport

That makes this a bidirectional session protocol, not a resource API and not a one-way log stream.

Using a dedicated WebSocket session keeps the design honest:

- no fake REST shape for command-oriented behavior
- no bind-mounted runtime socket path
- no extra custom framing layer
- one bidirectional control channel per worker session

## Control Plane Responsibilities

TARS remains responsible for:

- receiving GitHub webhooks and admin actions
- creating and updating session state
- persisting the canonical session transcript, logs, and checkpoints
- creating or reusing the primary issue worktree
- building the issue prompt from session state
- creating a per-session WebSocket reservation
- launching the worker container
- receiving worker session messages
- sending control and steering messages to the worker
- translating worker messages into session logs and `ExecutionResult`
- performing post-run delivery:
  - inspect workspace changes
  - commit and push the branch
  - create or update the PR
  - post issue comments and labels

These responsibilities line up with the current flow in:

- [src/app/commands/execute-session.ts](../src/app/commands/execute-session.ts)
- [src/app/commands/execute-session-delivery.ts](../src/app/commands/execute-session-delivery.ts)
- [src/app/commands/execute-session-reporter.ts](../src/app/commands/execute-session-reporter.ts)

## Worker Responsibilities

The worker is responsible for:

- booting the agent runtime
- connecting to the TARS worker session URL
- completing the hello and launch handshake
- setting `cwd` to the primary worktree
- loading the same TARS-authored prompt rules and status protocol
- executing tool calls, shell commands, file edits, and package installs
- sending event batches and heartbeat messages to TARS
- streaming assistant output, reasoning summaries, tool activity, and terminal state back to TARS
- receiving steering and control messages from TARS
- sending one terminal completion payload to TARS

This is a containerized version of the current in-process executor in:

- [src/executor/index.ts](../src/executor/index.ts)
- [src/executor/prompts.ts](../src/executor/prompts.ts)

## Trust Boundaries

### TARS Container

TARS may keep:

- GitHub credentials
- session state and jsonl history
- memory database
- Docker socket access
- admin HTTP surface

The LLM should not run here anymore.

### Worker Container

The worker gets:

- one read-write bind mount of the full workspace tree
- internet access
- a clean Debian-based filesystem per session
- model credentials only
- a session-specific WebSocket URL for the control-plane connection

The worker does not get:

- GitHub credentials
- `.env` from the TARS server environment
- TARS memory DB
- TARS admin credentials
- Docker socket
- a mounted LLM session directory
- direct access to TARS source checkout unless it is under the workspace mount

Important caveat:

- if any repository inside `WORKSPACES_DIR` contains its own `.env` or other secret-bearing files, the worker can read them because the full workspace tree is mounted read-write
- this design therefore assumes secrets are kept out of workspace checkouts

## Filesystem Layout

The worker mount model is:

- host: `WORKSPACES_DIR`
- container: `WORKSPACES_DIR` at the same absolute path used by TARS

TARS passes the primary worktree path separately, for example:

- `/app/workspaces/mbrooks-tars/.worktrees/issue-395`

All other repos under that shared workspace root are available for reference and ad hoc local work. This intentionally favors simplicity over fine-grained isolation.

The worker does not need a runtime mount for RPC.

Instead, TARS passes a session URL such as:

- `ws://127.0.0.1:6767/tars-worker/ws?sessionKey=mbrooks%2Ftars%23395&token=<opaque-token>`

In the Docker Compose deployment, workers share the TARS container network namespace, so loopback is the correct control-plane address from the worker's perspective.

## Process Model

One worker container is created per issue session.

- The worker may start background processes inside the container if needed.
- Those processes live only as long as the container lives.
- Cancelling the session kills the container and therefore all child processes.

This keeps cleanup simple and prevents detached processes from surviving outside the session boundary.

## Session Lifecycle

1. TARS receives or resumes an issue session.
2. TARS prepares the primary worktree.
3. TARS creates a per-session WebSocket reservation and token.
4. TARS launches a fresh worker container with the workspace mount and session URL.
5. The worker connects and sends `hello`.
6. TARS verifies the session key matches the reserved session and replies with `launch_config`.
7. The worker runs the agent against the primary worktree.
8. The worker streams `event_batch` and `heartbeat` messages during execution.
9. TARS may send `control` messages such as `pause`, `stop`, or `steer`.
10. The worker sends one terminal `complete` message.
11. TARS stores logs, updates session state, and handles delivery.
12. TARS removes the worker container and clears the session reservation.

## Logging Model

Central session logs stay in TARS.

- The worker sends structured event messages over the WebSocket session.
- TARS maps them into the existing session log system and persists the canonical session record.
- Worker stdout and stderr can still be captured by Docker for debugging, but they are not the authoritative control channel.

This keeps the existing admin log views conceptually intact while avoiding stdout as a protocol.

## Session Persistence

The worker should be treated as a stateless execution runtime.

- TARS owns persisted transcript and session history.
- The worker should not mount or write the long-lived LLM session directory used by TARS today.
- Assistant responses, reasoning summaries, tool activity, steering inputs, and terminal results should be streamed back over the WebSocket session.

If TARS later needs resumable execution, it should derive restart context from centrally persisted session history rather than a worker-owned on-disk session folder.

## Steering Model

Steering is explicit in this design.

- TARS may send a `control` message with `action: "steer"` and a text payload.
- The worker passes that text into the live agent session using the agent's existing steering mechanism.
- The worker acknowledges receipt and later reports resulting progress through normal events.

This makes steering a first-class part of the protocol rather than a future add-on.

## Security Notes

This design reduces exposure to host state and infra, but it does not prevent code or data exfiltration because:

- the worker has internet access
- the workspace mount is read-write
- all repos in the workspace are visible
- any secret files stored inside `WORKSPACES_DIR` are also visible to the worker

That is acceptable for V1 because the stated goal is to contain access to host state, secrets, and infra, not to solve egress control yet.

## Implemented Code Split

The executor boundary is implemented in two runtime layers:

- host-side session runner (`src/executor/docker-worker.ts` and `src/worker/rpc-server.ts`):
  - launches and supervises the worker container
  - hosts the worker session WebSocket server
  - converts worker messages into `ExecutionResult`
- worker-side agent runner (`src/worker/runtime.ts`):
  - reuses `PiAgentExecutor`
  - acts as a WebSocket client during execution

The host-side responsibilities are currently concentrated in `DockerWorkerExecutor`; separating Docker launch mechanics from session-protocol supervision remains an internal refactor opportunity, not a change to this architecture.
