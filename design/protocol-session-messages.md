# Protocol: Session Messages

## Purpose

This protocol defines the bidirectional messages used between a worker and TARS for one issue session.

## Common Envelope

All messages should include:

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "sessionKey": "mbrooks/tars#395",
  "messageId": "msg-1",
  "payload": {}
}
```

Required fields:

- `type`
- `protocolVersion`
- `sessionKey`
- `messageId`
- `payload`

## Message Set

V1 needs these message types:

- `hello`
- `launch_config`
- `ack`
- `event_batch`
- `heartbeat`
- `control`
- `complete`
- `error`

That is enough to support launch, logging, liveness, steering, and terminal result handoff.

## `hello`

### Direction

Worker -> TARS

### Purpose

The worker starts the session handshake and identifies which session it is claiming.

### Example

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "sessionKey": "mbrooks/tars#395",
  "messageId": "msg-1",
  "payload": {
    "workerVersion": "1.0.0",
    "pid": 42
  }
}
```

## `launch_config`

### Direction

TARS -> worker

### Purpose

TARS sends the authoritative launch payload after validating the session identity for that WebSocket connection.

### Example

```json
{
  "type": "launch_config",
  "protocolVersion": 1,
  "sessionKey": "mbrooks/tars#395",
  "messageId": "msg-2",
  "payload": {
    "session": {
      "owner": "mbrooks",
      "repo": "tars",
      "issueNumber": 395,
      "workspacePath": "/app/workspaces/mbrooks-tars/.worktrees/issue-395",
      "title": "Implement worker-based agent sessions",
      "body": "Design and build a new isolated worker runtime."
    },
    "prompt": {
      "kind": "issue",
      "text": "You are working on GitHub issue #395 in mbrooks/tars.\n..."
    },
    "limits": {
      "maxRuntimeSeconds": 7200
    }
  }
}
```

## `ack`

### Direction

Either direction

### Purpose

Acknowledges receipt and acceptance of a message.

### Example

```json
{
  "type": "ack",
  "protocolVersion": 1,
  "sessionKey": "mbrooks/tars#395",
  "messageId": "msg-3",
  "payload": {
    "ackMessageId": "msg-2"
  }
}
```

## `event_batch`

### Direction

Worker -> TARS

### Purpose

The worker sends structured execution events to TARS in batches.

### Example

```json
{
  "type": "event_batch",
  "protocolVersion": 1,
  "sessionKey": "mbrooks/tars#395",
  "messageId": "msg-4",
  "payload": {
    "events": [
      {
        "type": "session_log",
        "entry": {
          "timestamp": "2026-07-03T19:20:31.000Z",
          "level": "info",
          "message": "Prompt sent"
        }
      }
    ]
  }
}
```

### Event Types

The implemented V1 event type is `session_log`, containing the existing `SessionLogEntry` shape. Assistant output, reasoning summaries, tool activity, and status changes are represented through that canonical log entry rather than separate wire-level event variants.

## `heartbeat`

### Direction

Worker -> TARS

### Purpose

The worker periodically reports liveness while running.

### Example

```json
{
  "type": "heartbeat",
  "protocolVersion": 1,
  "sessionKey": "mbrooks/tars#395",
  "messageId": "msg-5",
  "payload": {
    "state": "running",
    "pid": 42,
    "timestamp": "2026-07-03T19:21:00.000Z"
  }
}
```

## `control`

### Direction

TARS -> worker

### Purpose

TARS sends live control or steering instructions to the worker.

### Allowed Actions

- `pause`
- `stop`
- `steer`

### `pause`

Reserved for a future resumable pause. The current worker handles it like `stop` by aborting the active agent execution.

### `stop`

Tells the worker to stop the active agent session and return a terminal result if possible.

### `steer`

Tells the worker to inject a text message into the live agent session.

### Example

```json
{
  "type": "control",
  "protocolVersion": 1,
  "sessionKey": "mbrooks/tars#395",
  "messageId": "msg-6",
  "payload": {
    "action": "steer",
    "message": "Focus on the failing guardrail test before changing UI code."
  }
}
```

### Steering Semantics

For `steer`:

1. TARS sends the message.
2. The worker responds with `ack`.
3. The worker passes the text into the live agent session through the agent's existing steering mechanism.
4. The worker continues normal event streaming.

If the worker cannot steer the live session, it should send `error` and then either:

- continue without steering, or
- stop and fail the session

The policy should be explicit in implementation.

## `complete`

### Direction

Worker -> TARS

### Purpose

The worker sends one terminal execution result to TARS.

### Example

```json
{
  "type": "complete",
  "protocolVersion": 1,
  "sessionKey": "mbrooks/tars#395",
  "messageId": "msg-7",
  "payload": {
    "result": {
      "status": "complete",
      "summary": "Implement worker session launch and result handling.",
      "rawResponse": "TARS_STATUS: complete\nImplement worker session launch and result handling."
    }
  }
}
```

### Result Semantics

The payload wraps the existing `ExecutionResult`. Allowed `payload.result.status` values are:

- `working`
- `waiting-feedback`
- `complete`
- `failed`
- `cancelled`

These should match the existing `ExecutionResult` shape used by TARS.

### Completion Rules

- The worker sends one completion result and then closes its connection during cleanup.
- TARS treats that result as the execution result returned to the existing reporting and delivery flow.
- The worker must not push or create the PR itself.

## `error`

### Direction

Either direction

### Purpose

Reports a protocol-level or session-level error.

### Example

```json
{
  "type": "error",
  "protocolVersion": 1,
  "sessionKey": "mbrooks/tars#395",
  "messageId": "msg-8",
  "payload": {
    "message": "Agent session could not accept a steering message."
  }
}
```

## Host Mapping

TARS translates worker messages like this:

- `event_batch` -> `recordSessionLog` and activity updates for each `session_log` entry
- `heartbeat` -> liveness tracking and activity updates
- `complete` -> `ExecutionResult` handoff into the existing reporting and delivery flow

The `event_batch` stream carries the data TARS persists centrally, including:

- assistant responses
- reasoning summaries
- tool execution events
- steering-related status updates

TARS exposes live steering and stop actions through outbound `control` messages.

## Missing Completion Handling

If the container exits or the WebSocket closes before a successful `complete` message, the host rejects the execution with an error containing the captured Docker stderr/stdout tail when available. Existing session reporting converts that execution failure into the normal failed-session behavior.
