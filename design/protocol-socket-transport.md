# Protocol: Socket Transport

## Purpose

This protocol defines the transport rules for the TARS session protocol between TARS and the worker.

## Transport Choice

Use a Unix domain socket with explicit message framing.

This gives:

- full-duplex communication
- one long-lived connection per session
- natural streaming for logs and tool events
- natural server-initiated steering
- no host TCP port exposure
- no dependency on web protocols or MCP

## Roles

- TARS is the server.
- The worker is the client.

There is one server instance per active session.

## Socket Location

Example:

- host: `/app/sessions/runtime/github-mbrooks-tars-issue-395/session.sock`
- container: `/tars-runtime/session.sock`

The socket exists only for the lifetime of the session.

## Session Isolation

Each session gets its own dedicated Unix socket.

Recommended identity fields:

- `sessionKey`
- `protocolVersion`

TARS should reject connections with:

- session key mismatch
- protocol version mismatch
- unexpected second client for the same live session

## Connection Lifecycle

1. Worker opens the Unix socket connection.
2. Worker sends `hello`.
3. TARS validates the session key against the socket's assigned session and returns `launch_config`.
4. Worker sends `ack`.
5. Session traffic continues until `complete` or shutdown.

## Message Framing

V1 should pick one of these:

- newline-delimited JSON
- length-prefixed JSON

Recommended V1 choice:

- length-prefixed JSON

Why:

- no ambiguity around embedded newlines in payload strings
- easier binary-safe framing
- cleaner for long assistant messages and tool output

Each framed message should contain one JSON object with:

- `type`
- `protocolVersion`
- `sessionKey`
- `messageId`
- `payload`

## Ordering

Message order matters for:

- control messages
- event batches
- terminal completion

TARS should process messages in receive order per connection. The worker should process TARS control messages in receive order as well.

## Acknowledgements

The protocol should support explicit `ack` messages for:

- `launch_config`
- `control`
- optionally `complete`

This makes steering and pause/stop semantics observable.

## Reconnect

V1 may choose one of two policies:

- simple policy:
  - any disconnect is treated as session failure unless completion already arrived
- reconnect policy:
  - the worker reconnects with the same session key
  - TARS resumes the session if it is still active

Recommended V1 choice:

- use the simple policy first

It keeps implementation smaller and makes failure cases easier to reason about.

## Heartbeat

The worker should send explicit `heartbeat` messages so TARS can update session activity and distinguish a healthy idle worker from a stuck one.

## Shutdown

When the session ends:

1. TARS stops accepting non-terminal session messages.
2. TARS closes the socket connection.
3. TARS removes the socket file and runtime directory.

If the worker exits first, TARS should detect container exit and close the server cleanly.

## Observability

The session socket is the authoritative control channel.

Worker stdout and stderr may still be captured by Docker for debugging, but TARS should not rely on them for correctness.
