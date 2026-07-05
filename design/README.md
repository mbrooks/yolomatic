# Worker Session Design

This folder describes a proposed TARS runtime split where:

- TARS remains the deterministic control plane.
- A fresh worker container runs the full LLM agent for each issue session.
- The worker can read and write any repository under the shared workspace mount.
- The worker has no GitHub credentials, no Docker socket, and no direct access to TARS state.
- TARS and the worker communicate through a bidirectional session protocol over a WebSocket connection.

## Documents

- [architecture.md](architecture.md): system overview, trust boundaries, and lifecycle
- [protocol-launch.md](protocol-launch.md): how TARS starts a worker session and exposes the worker session URL
- [protocol-websocket-transport.md](protocol-websocket-transport.md): transport, session isolation, reconnect, and shutdown rules
- [protocol-session-messages.md](protocol-session-messages.md): bidirectional message types for launch, events, heartbeat, steering, and completion

## Goals

- Keep orchestration, repo management, push, and PR delivery in TARS.
- Run the agent in an isolated, disposable Debian worker container.
- Support live steering and stop/pause semantics over one session connection.
- In Docker Compose deployments, let workers share the TARS container network namespace so they reach TARS and Ollama over `127.0.0.1` instead of a host-published port.
- Keep `WORKSPACES_DIR` identical in the control plane and worker so git worktree metadata stays valid without path rewriting.
- Keep the first implementation simple:
  - one worker per issue session
  - one read-write mount for the full workspace tree
  - internet access enabled
  - one session-scoped WebSocket connection
  - no MCP dependency

## Non-Goals For V1

- Egress filtering
- Fine-grained per-repo mount isolation
- In-worker GitHub operations
- Persistent tool caches across worker sessions
- Host-side tool exposure through MCP
- Multi-worker coordination for one session
