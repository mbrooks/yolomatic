# Worker Session Design

This folder describes a proposed TARS runtime split where:

- TARS remains the deterministic control plane.
- A fresh worker container runs the full LLM agent for each issue session.
- The worker can read and write any repository under the shared workspace mount.
- The worker has no GitHub credentials, no Docker socket, and no direct access to TARS state.
- TARS and the worker communicate through a bidirectional session protocol over a Unix domain socket.

## Documents

- [architecture.md](architecture.md): system overview, trust boundaries, and lifecycle
- [protocol-launch.md](protocol-launch.md): how TARS starts a worker session and exposes the session socket
- [protocol-socket-transport.md](protocol-socket-transport.md): transport, framing, session isolation, reconnect, and shutdown rules
- [protocol-session-messages.md](protocol-session-messages.md): bidirectional message types for launch, events, heartbeat, steering, and completion

## Goals

- Keep orchestration, repo management, push, and PR delivery in TARS.
- Run the agent in an isolated, disposable Debian worker container.
- Support live steering and stop/pause semantics over one session connection.
- Keep the first implementation simple:
  - one worker per issue session
  - one read-write mount for the full workspace tree
  - internet access enabled
  - one session-scoped Unix socket
  - no MCP dependency

## Non-Goals For V1

- Egress filtering
- Fine-grained per-repo mount isolation
- In-worker GitHub operations
- Persistent tool caches across worker sessions
- Host-side tool exposure through MCP
- Multi-worker coordination for one session
