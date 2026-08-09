# Protocol: Session Messages

Status: as-built design

Last verified: 2026-08-01 against `github/main` at `26171605efdd`

## Purpose

This protocol defines the bidirectional messages used between a worker and Yolomatic for one issue session.

## Common Envelope

All messages include:

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "sessionKey": "mbrooks/yolomatic#395",
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
- `tool_request`
- `tool_response`

That is enough to support launch, logging, liveness, steering, terminal result handoff, and scoped GitHub tool calls.

The `tool_request` / `tool_response` pair is an additive V1 addition: both
messages reuse the existing envelope and `ack` mechanism, and a worker that
never sends `tool_request` (or a control plane that never sends
`tool_response`) remains protocol-compatible. `WORKER_PROTOCOL_VERSION` is
therefore left at `1`.

## `hello`

### Direction

Worker -> Yolomatic

### Purpose

The worker starts the session handshake and identifies which session it is claiming.

### Example

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "sessionKey": "mbrooks/yolomatic#395",
  "messageId": "msg-1",
  "payload": {
    "workerVersion": "1.0.0",
    "pid": 42
  }
}
```

## `launch_config`

### Direction

Yolomatic -> worker

### Purpose

Yolomatic sends the authoritative launch payload after validating the session identity for that WebSocket connection.

### Example

```json
{
  "type": "launch_config",
  "protocolVersion": 1,
  "sessionKey": "mbrooks/yolomatic#395",
  "messageId": "msg-2",
  "payload": {
    "session": {
      "owner": "mbrooks",
      "repo": "yolomatic",
      "issueNumber": 395,
      "workspacePath": "/app/workspaces/mbrooks-yolomatic/.worktrees/issue-395",
      "title": "Implement worker-based agent sessions",
      "body": "Design and build a new isolated worker runtime."
    },
    "prompt": {
      "kind": "issue",
      "text": "You are working on GitHub issue #395 in mbrooks/yolomatic.\n..."
    },
    "limits": {
      "maxRuntimeSeconds": 7200
    }
  }
}
```

`limits.maxRuntimeSeconds` is currently descriptive. The worker and host do not
enforce it as a deadline.

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
  "sessionKey": "mbrooks/yolomatic#395",
  "messageId": "msg-3",
  "payload": {
    "ackMessageId": "msg-2"
  }
}
```

## `event_batch`

### Direction

Worker -> Yolomatic

### Purpose

The worker sends structured execution events to Yolomatic. The current runtime
emits one `session_log` event per `event_batch`; the array permits future
coalescing.

### Example

```json
{
  "type": "event_batch",
  "protocolVersion": 1,
  "sessionKey": "mbrooks/yolomatic#395",
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

Worker -> Yolomatic

### Purpose

The worker periodically reports liveness while running.

The current interval is five seconds. The host updates session activity but
does not enforce a heartbeat timeout.

### Example

```json
{
  "type": "heartbeat",
  "protocolVersion": 1,
  "sessionKey": "mbrooks/yolomatic#395",
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

Yolomatic -> worker

### Purpose

Yolomatic sends live control or steering instructions to the worker.

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
  "sessionKey": "mbrooks/yolomatic#395",
  "messageId": "msg-6",
  "payload": {
    "action": "steer",
    "message": "Focus on the failing guardrail test before changing UI code."
  }
}
```

### Steering Semantics

For `steer`:

1. Yolomatic sends the message.
2. The worker responds with `ack` before applying the action.
3. The worker passes the text into the live agent session through the agent's existing steering mechanism.
4. The worker continues normal event streaming.

The acknowledgement confirms receipt, not successful application. If steering
arrives before a live agent session exists or steering otherwise fails, the
worker sends `error`. The host treats that error as an execution failure.

## `complete`

### Direction

Worker -> Yolomatic

### Purpose

The worker sends one terminal execution result to Yolomatic.

### Example

```json
{
  "type": "complete",
  "protocolVersion": 1,
  "sessionKey": "mbrooks/yolomatic#395",
  "messageId": "msg-7",
  "payload": {
    "result": {
      "status": "complete",
      "summary": "Implement worker session launch and result handling.",
      "rawResponse": "YOLO_STATUS: complete\nImplement worker session launch and result handling."
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

These match the existing `ExecutionResult` shape used by Yolomatic.

### Completion Rules

- The worker sends one completion result and then closes its connection during cleanup.
- Yolomatic treats that result as the execution result returned to the existing reporting and delivery flow.
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
  "sessionKey": "mbrooks/yolomatic#395",
  "messageId": "msg-8",
  "payload": {
    "message": "Agent session could not accept a steering message."
  }
}
```

## `tool_request`

### Direction

Worker -> Yolomatic

### Purpose

The worker asks the control plane to perform a scoped GitHub operation on its
behalf. The disposable worker never receives `GITHUB_TOKEN`; the control-plane
`WorkerGitHubGateway` validates the request against the live `SessionState`
(current issue + its associated PRs) and performs the GitHub call through the
control plane's `GitHubService` instance.

### Example

```json
{
  "type": "tool_request",
  "protocolVersion": 1,
  "sessionKey": "mbrooks/yolomatic#395",
  "messageId": "tool-1",
  "payload": {
    "tool": "fetch_issue",
    "params": { "include_comments": true }
  }
}
```

### Tools

Issue tools (scoped to the session issue; no `owner`/`repo`/`issue_number`
parameters):

- `get_authenticated_user`
- `fetch_issue` (`include_comments?: boolean`)
- `set_comment` (`body`)
- `set_status` (`state?`, `assignee?`)
- `set_labels` (`labels?`, `addLabels?`, `removeLabels?`)
- `update_issue` (`title?`, `body?`, `state?`, `labels?`, `assignees?`)
- `update_main_from_origin` (no params; refreshes the control-plane bare repo's
  local default-branch ref from `origin/{effectiveDefaultBranch}` for the
  session repo, returns `{ branch, before, after, updated }`; scoped to the
  session repo, never accepts `owner`/`repo`/`branch`)

PR tools (scoped to the session's linked PR or an open PR on the session
branch `yolomatic/issue-{n}`; accept an optional in-scope `pr_number`):

- `fetch_pr` (`pr_number?`, `include_comments?`)
- `set_pr_comment` (`body`, `pr_number?`)
- `update_pr` (`title?`, `body?`, `state?`, `labels?`, `pr_number?`)
- `list_pr_review_comments` (`pr_number?`)

Broad discovery tools (`github_query_issues`, `github_assigned_open_issues`)
and the token-probe form of `github_get_authenticated_user` are intentionally
not exposed to the worker because they cannot be scoped to the current issue.

### Handling

1. The worker sends `tool_request` over the session WebSocket.
2. The control plane sends `ack` (acknowledging receipt).
3. The control plane validates scope and performs the GitHub call (or rejects
   without a GitHub call for out-of-scope `owner`/`repo`/`issue_number`).
4. The control plane sends `tool_response` with the result, correlated by
   `payload.requestMessageId`.

## `tool_response`

### Direction

Yolomatic -> worker

### Purpose

Carries the result of a `tool_request`. `requestMessageId` correlates the
response to the originating request so the worker can multiplex concurrent
calls. `ok: false` with `scopeError: true` indicates the request was rejected
for targeting an out-of-scope issue or PR; no GitHub operation was performed
in that case.

### Example

```json
{
  "type": "tool_response",
  "protocolVersion": 1,
  "sessionKey": "mbrooks/yolomatic#395",
  "messageId": "resp-1",
  "payload": {
    "requestMessageId": "tool-1",
    "ok": true,
    "data": { "issue": { "number": 395 } }
  }
}
```

## Host Mapping

Yolomatic translates worker messages like this:

- `event_batch` -> `recordSessionLog` and activity updates for each `session_log` entry
- `heartbeat` -> activity updates; there is no protocol-level heartbeat watchdog
- `complete` -> `ExecutionResult` handoff into the existing reporting and delivery flow
- `tool_request` -> `ack`, scope-validated `WorkerGitHubGateway` dispatch, and a `tool_response` carrying the result or a scope/error failure

The `event_batch` stream carries the data Yolomatic persists centrally, including:

- assistant responses
- reasoning summaries
- tool execution events
- steering-related status updates

Yolomatic exposes live steering and stop actions through outbound `control` messages.

## Missing Completion Handling

If the container exits or the WebSocket closes before a successful `complete` message, the host rejects the execution with an error containing the captured Docker stderr/stdout tail when available. Existing session reporting converts that execution failure into the normal failed-session behavior.
