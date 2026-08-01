# Architecture

Status: as-built design

Last verified: 2026-08-01 against `github/main` at `26171605efdd`

## Summary

Yeetomatic runs as a control plane and launches a separate worker container for each issue execution. The worker owns agent execution and code changes. Yeetomatic owns everything deterministic before and after the run.

The control plane and worker communicate through a bidirectional session protocol over a WebSocket connection. Yeetomatic hosts the server side on its existing control-plane HTTP server. The worker is the client that connects with a session-specific URL and token.

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

Yeetomatic remains responsible for:

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
- connecting to the Yeetomatic worker session URL
- completing the hello and launch handshake
- setting `cwd` to the primary worktree
- loading the same Yeetomatic-authored prompt rules and status protocol
- executing tool calls, shell commands, file edits, and package installs
- sending event batches and heartbeat messages to Yeetomatic
- streaming assistant output, reasoning summaries, tool activity, and terminal state back to Yeetomatic
- receiving steering and control messages from Yeetomatic
- sending one terminal completion payload to Yeetomatic

This is a containerized version of the current in-process executor in:

- [src/executor/index.ts](../src/executor/index.ts)
- [src/executor/prompts.ts](../src/executor/prompts.ts)

## Trust Boundaries

### Yeetomatic Container

Yeetomatic may keep:

- GitHub credentials
- session state and jsonl history
- memory database
- Docker socket access
- admin HTTP surface

The LLM does not run in the control-plane process.

### Worker Container

The worker gets:

- one read-write mount of the full workspace tree, backed by either a Docker
  volume or host bind mount
- internet access
- a fresh writable container filesystem per execution
- only the explicitly forwarded model/session environment variables
- a session-specific WebSocket URL for the control-plane connection

The worker does not get:

- GitHub credentials
- `.env` from the Yeetomatic server environment
- Yeetomatic memory DB
- Yeetomatic admin credentials
- Docker socket
- control-plane runtime and memory volumes
- a mounted LLM session directory
- direct access to Yeetomatic source checkout unless it is under the workspace mount

Important caveat:

- if any repository inside `WORKSPACES_DIR` contains its own `.env` or other secret-bearing files, the worker can read them because the full workspace tree is mounted read-write
- this design therefore assumes secrets are kept out of workspace checkouts

## Filesystem Layout

The worker mount model is:

- source: the configured `worker_workspace_mount_source`, resolved to the
  control-plane container's actual workspace volume or bind source when
  possible
- container: `WORKSPACES_DIR` at the same absolute path used by Yeetomatic

Yeetomatic passes the primary worktree path separately, for example:

- `/app/workspaces/mbrooks-yeetomatic/.worktrees/issue-395`

All other repos under that shared workspace root are available for reference and ad hoc local work. This intentionally favors simplicity over fine-grained isolation.

The worker does not need a runtime mount for RPC.

Instead, Yeetomatic passes a session URL such as:

- `ws://127.0.0.1:6767/yeetomatic-worker/ws?sessionKey=mbrooks%2Fyeetomatic%23395&token=<opaque-token>`

In the Docker Compose deployment, workers share the Yeetomatic container network namespace, so loopback is the correct control-plane address from the worker's perspective.

In deployments without `container:*` networking, Yeetomatic adds
`host.docker.internal:host-gateway` and rewrites a loopback `OLLAMA_HOST` to
`host.docker.internal`. An explicit worker Ollama URL takes precedence.

## Process Model

One worker container is created per execution attempt. Feedback and restart
resumption can create later worker containers for the same durable issue
session.

- The worker may start background processes inside the container if needed.
- Those processes live only as long as the container lives.
- Cancelling first asks the worker to abort the agent. After that control
  acknowledgement succeeds or fails, Yeetomatic arms a five-second
  `docker stop` fallback for the container and its child processes.

This keeps cleanup simple and prevents detached processes from surviving outside the session boundary.

## Docker Worker Management

The current host-side implementation manages worker containers as follows:

- Before the first launch in a control-plane process, it builds the Dockerfile
  `worker` target and tags the configured worker image. One shared promise
  serializes that build; Docker layer caching avoids rebuilding unchanged
  layers.
- A session receives a deterministic Docker name in the form
  `yeetomatic-session-{owner}-{repo}-{issueNumber}`, normalized to Docker-safe
  characters.
- The launch uses `docker run --rm`, so a normally exiting or stopped worker is
  removed by Docker.
- Workers do not receive a Docker restart policy. A control-plane restart does
  not adopt or reconcile an existing worker container.
- If launch fails because that deterministic name is already in use,
  Yeetomatic inspects the conflicting container. It removes and retries only
  containers in `created`, `dead`, or `exited` state. A running or unknown
  container is preserved and the launch fails closed.
- Conflict recovery allows three retries after the initial launch attempt.
- Docker stdout and stderr are retained as bounded diagnostic tails. If the
  container exits before sending `complete`, the execution fails with its exit
  information and available output.

There is no independent Docker worker scheduler or reconciliation loop. The
session executor owns each `docker run` child process for the duration of that
execution.

## Session Lifecycle

1. Yeetomatic receives or resumes an issue session.
2. Yeetomatic prepares the primary worktree.
3. Yeetomatic ensures the worker image is ready.
4. Yeetomatic creates a per-attempt WebSocket reservation and token.
5. Yeetomatic launches a fresh worker container with the workspace mount and session URL.
6. The worker connects and sends `hello`.
7. Yeetomatic verifies the session key matches the reserved session and replies with `launch_config`.
8. The worker acknowledges the launch and runs the agent against the primary worktree.
9. The worker streams `event_batch` and `heartbeat` messages during execution.
10. Yeetomatic may send `control` messages such as `pause`, `stop`, or `steer`.
11. The worker sends one terminal `complete` message.
12. Yeetomatic stores logs, updates session state, and handles delivery.
13. The worker exits, Docker removes the `--rm` container, and Yeetomatic
    closes the connection and disposes the reservation.

## Logging Model

Central session logs stay in Yeetomatic.

- The worker sends structured event messages over the WebSocket session.
- Yeetomatic maps them into the existing session log system and persists the canonical session record.
- Worker stdout and stderr can still be captured by Docker for debugging, but they are not the authoritative control channel.

This keeps the existing admin log views conceptually intact while avoiding stdout as a protocol.

## Session Persistence

The worker is treated as a stateless execution runtime.

- Yeetomatic owns persisted transcript and session history.
- The worker does not mount or write the long-lived LLM session directory used by Yeetomatic today.
- Assistant responses, reasoning summaries, tool activity, steering inputs, and terminal results are streamed back over the WebSocket session.

If Yeetomatic later needs resumable execution, it should derive restart context from centrally persisted session history rather than a worker-owned on-disk session folder.

## Steering Model

Steering is explicit in this design.

- Yeetomatic may send a `control` message with `action: "steer"` and a text payload.
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
