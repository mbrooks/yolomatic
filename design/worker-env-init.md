# Worker Environment Initialization Script

Status: proposed design

Last updated: 2026-08-05

## Purpose

Yeetomatic should deterministically initialize the worker environment before
the agent starts. Today a fresh disposable worker container is launched per
issue execution, and the agent is handed the workspace as-is. Repository
dependencies (for example `node_modules` from `npm install`) may be missing or
stale, so the agent's first tool calls often rebuild the environment ad hoc,
non-deterministically, and with results that do not persist past the worker
container.

This design adds a single, deterministic initialization step to the worker
launch sequence: after the worker receives `launch_config` and acknowledges
it, and before the agent executor is created, the worker changes into the
project workspace, looks for a repository-provided init shell script, and
executes it if present. The classic case is one `npm install` invocation that
materializes `node_modules` so the agent can run tests, builds, and lint
without first spending model turns installing dependencies.

The init script is opt-in by convention. When no script is present, behavior is
unchanged. The control plane is not involved in running the script; the script
runs inside the worker container, as the worker user, against the mounted
workspace.

## Trust Model

The init script is repository content, not Yeetomatic configuration. It runs
inside the same trust boundary as the agent itself: the worker container that
Yeetomatic launches for an issue already executes arbitrary shell commands,
reads and writes the mounted workspace, and reaches the network. The init
script does not add new capabilities; it runs earlier in the same container
with the same privileges as the agent.

The worker runs as the non-root `yeetomatic` user with `HOME=/home/yeetomatic`.
System package installation with `apt-get` is not available during an ordinary
worker session (the worker image has no root and no `apt-get` cache mounted).
The init script is therefore limited to user-writable tooling: `npm install`,
`pip install --user`, `cargo build`, `go mod download`, `pnpm install`,
generating lock files, compiling native extensions that do not require system
headers, etc. A script that needs `apt-get` or root cannot succeed in the
worker; that requirement belongs in the worker image, not the init script.

Because the workspace volume is shared across worker launches (and with the
control plane), anything the init script writes inside the workspace —
including `node_modules` — persists across worker sessions for the same
repository and is visible to subsequent launches. This is the mechanism that
makes initialization cheap on the second run: the first worker pays the
`npm install` cost, later workers detect an already-populated `node_modules`
and the script can no-op or skip. Determinism here means "deterministically
attempted," not "always rebuilt from scratch."

## Goals

- Run the init script deterministically on every worker launch, before the
  agent starts, so the environment is in a known state before the first model
  turn.
- Keep the mechanism opt-in by convention: no script, no change in behavior.
- Keep the mechanism repository-owned: the script lives in the repository
  workspace, not in the Yeetomatic image or control-plane config.
- Stream the script's stdout and stderr to the control plane as session log
  events so a maintainer can watch `npm install` progress in the session log.
- Fail closed: a non-zero exit from the init script aborts the worker session
  with a clear error rather than starting the agent against a broken
  environment.
- Allow the control plane to disable the mechanism per launch or override the
  script path through container environment variables, without code changes.
- Preserve the existing launch handshake and protocol; the init step is an
  internal worker-runtime phase, not a new protocol message type.

## Non-Goals

- Running system package installation (`apt-get install`) as the worker user.
  That belongs in the `worker` Dockerfile target.
- Running the init script on the control plane. The control plane does not
  have the project's toolchain and must not execute repository shell code.
- Caching the init script result across control-plane restarts in a separate
  cache volume. The shared workspace mount already persists workspace-written
  artifacts.
- Supporting more than one init script per launch. One script is the
  deterministic contract; chaining is the script's responsibility.
- Making the init script a required field. Absence is the common case and
  remains zero-cost.
- Letting the init script influence the launch handshake, prompt, or model
  selection. It only mutates the workspace.
- Running the init script for control-plane (non-worker) processes.

## Script Discovery

The worker looks for the init script at a path relative to the resolved
workspace path, using these precedence rules:

1. `YEETOMATIC_WORKER_INIT_SCRIPT` if set and non-empty (resolved relative to
   the workspace path when not absolute).
2. Otherwise `yeetstrap.sh` relative to the workspace path.

The repository root is the established convention for project-level entry
points: it is where a maintainer already expects to find tooling scripts such
as `build.sh`, `test.sh`, or `Makefile`-driven wrappers. Placing the init
script at the repository root as `yeetstrap.sh` makes it discoverable alongside
those existing scripts and does not require a Yeetomatic-specific directory to
exist. The `.pi/` directory remains reserved for Yeetomatic-owned artifacts
(skills under `.pi/skills/`, trusted extensions under `.pi/extensions/`); the
init script is repository-owned tooling and belongs at the root, not under
`.pi/`.

The script must:

- be a regular file,
- be readable by the `yeetomatic` user,
- be non-empty,
- have a `#!/...` shebang or be executable as a `bash` script.

Executable bit is not required. The worker invokes the script through `bash`
explicitly, so `chmod +x` is optional. This avoids a class of cross-platform
"lost executable bit" problems when repositories are checked out on Windows
hosts or through filters that drop the mode.

## Invocation

The worker performs the following steps in order, inside the worker container,
as the `yeetomatic` user, after the `launch_config` acknowledgement is sent
and before `PiAgentExecutor` is constructed:

1. Resolve the workspace path from `launch_config.payload.session.workspacePath`.
2. `chdir` into the workspace path. If the directory is not accessible, abort
   the session with a launch-validation error (this is the same path the
   agent would use, so a missing workspace is a launch failure regardless of
   the init step).
3. Resolve the init script path using the discovery rules above.
4. If the script does not exist, skip the init phase entirely and proceed to
   agent execution. No log line is emitted in this case; absence is silent and
   zero-cost.
5. If the script exists but is empty or unreadable, abort the session with a
   clear `env_init` error. An empty script is almost certainly a mistake.
6. Spawn the script:

   ```bash
   bash -c 'cd "<workspacePath>" && exec bash -- "<scriptPath>"'
   ```

   The `cd` is explicit and redundant with step 2 but makes the script's
   working directory deterministic even if the script itself `cd`s away and
   back. `exec bash` (not `./yeetstrap.sh`) ignores the executable bit and the
   script's own shebang choice, so the script runs under the worker image's
   `bash` regardless of how it was committed.

7. Inherit the worker process environment. The script sees the same
   environment the agent will see: `HOME`, `PATH`, `OLLAMA_HOST`,
   `PI_AGENT_PROVIDER`, `PI_AGENT_MODEL`, `NODE_ENV`, and the workspace
   relative `PATH` additions the worker image already provides. The script
   does not see `GITHUB_TOKEN` (the worker never has it) and does not see
   `YEETOMATIC_SESSION_WS_URL` after the handshake (the worker may unset
   request-scoped env before spawning the script; see Environment Hygiene
   below).
8. Pipe stdout and stderr to the worker's session log emitter as
   `session_log` events with `level: "info"` for stdout and `level: "warn"`
   for stderr, tagged `details.type: "env_init"`. These events flow over the
   existing `event_batch` channel to the control plane and are persisted by
   the same `recordSessionLog` path the agent uses.
9. Wait for the script to exit.

A 30-minute wall-clock soft timeout is enforced by the worker runtime. If the
script exceeds it, the worker kills the process, emits a final `env_init`
error log line, and aborts the session. The timeout is long enough for a cold
`npm install` of a large monoread and short enough that a hung script does not
burn the full `maxRuntimeSeconds` budget. The timeout is configurable via
`YEETOMATIC_WORKER_INIT_TIMEOUT_SECONDS` (default `1800`).

## Failure Handling

The init step fails closed. The following outcomes abort the worker session
before the agent starts, each reported as a worker `error` message to the
control plane and recorded in the session log:

- Script exits non-zero. The exit code and the last 4 KiB of stderr are
  included in the error message so a maintainer can see what failed without
  grepping logs.
- Script is killed by a signal (for example `SIGKILL` from the timeout
  enforcement). Reported as `env_init timeout` or `env_init killed`.
- Script cannot be spawned (`ENOENT` on `bash`, workspace vanished, etc.).
  Reported as a launch-validation error.
- Script exceeds the configured timeout.

The worker does not retry the init script. A failed init is a deterministic
failure of environment preparation; retrying the same script in the same
container would produce the same result. The control plane's existing
session-retry path (a new worker launch) is the retry mechanism, and on that
relaunch the init script runs again from scratch in a fresh container — but
with whatever workspace artifacts (e.g. partial `node_modules`) the previous
attempt left behind, since the workspace volume is shared.

A maintainer who needs to inspect the environment after a failed init can
disable the init step (see Disabling) and let the agent run, or run the
script manually inside a worker shell.

## Environment Hygiene

The init script runs with the worker process environment, with two
exceptions:

- `YEETOMATIC_SESSION_WS_URL` is unset before the script is spawned. The
  WebSocket URL is a single-use reservation token; the script should not see
  it and has no use for it.
- `YEETOMATIC_SESSION_KEY` is preserved. It is a non-secret
  `owner/repo#number` descriptor and is useful for log lines the script might
  emit.

No GitHub credentials are present in the worker environment, so there is
nothing additional to scrub. The init script cannot escalate to GitHub
operations it would not otherwise have.

## Determinism and Caching

"Deterministic init" means the worker always attempts the same preparation
step in the same way before the agent starts. It does not mean the script is
idempotent or that the environment is rebuilt from scratch each time.

The shared workspace mount is the cache. Concrete example for a Node project:

1. First worker launch: `yeetstrap.sh` runs `npm ci`. `node_modules` is
   materialized inside the workspace. The container exits.
2. Second worker launch (same repo, same workspace volume): `yeetstrap.sh`
   runs `npm ci` again. `npm` sees `node_modules` already present and
   matching the lockfile, does a fast verification, and exits near-instantly.
   The agent starts with a warm environment.

A repository that wants a truly clean rebuild each time can make its
`yeetstrap.sh` remove `node_modules` first. That is a repository policy
decision, not a Yeetomatic decision.

Yeetomatic does not checksum the environment before or after the init script.
The contract is "run this script; if it succeeds, start the agent." A
repository that wants stronger guarantees (for example, refuse to start if
`npm ci` produced a modified lockfile) encodes that in the script and exits
non-zero on violation.

## Configuration

All configuration is by container environment variable, passed to the worker
through the existing `docker run` env propagation in `DockerWorkerExecutor`.
None of these variables are required; all have safe defaults.

| Variable | Default | Purpose |
| --- | --- | --- |
| `YEETOMATIC_WORKER_INIT_SCRIPT` | `yeetstrap.sh` | Path to the init script, resolved relative to the workspace path when not absolute. Set to an absolute path to point outside the workspace (rare). |
| `YEETOMATIC_WORKER_INIT_SKIP` | `0` | When set to `1` (or `true`), the worker skips the init phase entirely even if a script is present. Used by maintainers to debug a broken environment. |
| `YEETOMATIC_WORKER_INIT_TIMEOUT_SECONDS` | `1800` | Wall-clock seconds before the init script is killed. |

The control plane reads these from its own process environment in
`DockerWorkerExecutor.buildDockerRunArgs` and forwards them to the worker
container with `-e`, the same way `PI_AGENT_PROVIDER` and `PI_AGENT_MODEL`
are forwarded today. The control plane does not interpret their values; it
only passes them through. This keeps the authoritative interpretation in the
worker, where the script actually runs.

The `.env.example` file should document these three variables as optional,
grouped with the existing `YEETOMATIC_WORKER_*` variables.

## Where the Init Step Lives in Code

The init step belongs in the worker runtime, not in the executor, because:

- the worker runtime already holds the resolved workspace path from
  `launchConfig.payload.session.workspacePath`,
- the worker runtime already owns the session log emitter used to stream
  init output, and
- keeping it out of `PiAgentExecutor` preserves the executor as a thin
  adapter over the pi-coding-agent SDK and keeps it testable in isolation.

Concretely, in `src/worker/runtime.ts`, between the `ack` send and the
construction of `PiAgentExecutor`, the runtime calls a new
`runEnvironmentInit({ workspacePath, scriptPath, timeoutSeconds, skip, log })
` helper. The helper:

1. resolves and stats the script,
2. returns early when `skip` is set or the script is absent,
3. spawns the script via `child_process.spawn` with `cwd: workspacePath`,
4. wires stdout/stderr to `recordSessionLog`-equivalent `session_log` events
   through the existing `onSessionLogEvent` listener (or, more simply, emits
   `event_batch` messages directly over the WebSocket using the same
   `sendMessage` path used for agent log events),
5. resolves on exit code `0`,
6. rejects with a typed `EnvInitError` on non-zero exit, signal death, or
   timeout.

The rejection propagates through the existing `try/catch` in
`runWorkerRuntime`, which already converts a thrown error into a worker
`error` message and rethrows. No new protocol message type is needed; the
init phase reuses `event_batch` for output and `error` for failure.

A new module `src/worker/env-init.ts` holds the helper and its pure
sub-functions (path resolution, stat checks, spawn, output framing) so it can
be unit-tested without a real WebSocket. `src/worker/env-init.test.ts` covers
the success, skip, absence, empty-script, non-zero-exit, signal, and timeout
branches.

## Control-Plane Changes

The control-plane change is a one-block addition to
`DockerWorkerExecutor.buildDockerRunArgs` that forwards the three
`YEETOMATIC_WORKER_INIT_*` variables when they are present in
`process.env`, mirroring the existing `PI_AGENT_*` forwarding. No control
plane logic interprets these values.

No schema migration is needed. No new session state field is needed; the init
phase is an ephemeral worker-runtime concern and is not persisted as session
state. Its output is persisted as `session_log` entries with
`details.type: "env_init"`, queryable by the existing log infrastructure.

## Worker Image Changes

None. The worker image (`node:24-bookworm-slim` based) already includes
`bash`, `git`, `node`, and common shell tools. The init script runs under
`bash` and inherits the image's `PATH`. If a repository's init script needs a
tool the worker image lacks (for example `python3` for a `pip install --user`
project), the fix is to add that tool to the `worker` Dockerfile target, not
to special-case it in the init mechanism.

This is worth calling out in the design because it bounds what an init script
can reasonably do: the script is a user-space convenience for project-level
dependency materialization, not a hook to install system packages.

## Interaction with Existing Behavior

- **Launch handshake**: unchanged. The init step runs after the `ack` for
  `launch_config` and before agent execution. The control plane sees the
  worker connect, `hello`, `ack` the `launch_config`, and then a stream of
  `event_batch` messages (init output) before any agent activity. The
  control plane does not distinguish init output from agent output except by
  the `details.type` tag.
- **Heartbeat**: the heartbeat starts after the launch config is acked (as
  today). The init script runs while heartbeats are flowing, so the control
  plane sees the worker as alive during `npm install`. `onActivity` is
  called for each init output line, so stale-session detection does not fire
  during a long `npm install`.
- **Cancellation**: a `control` `stop` arriving during init should be honored.
  The init spawn's `AbortController` is the same one used for agent
  execution; aborting it kills the init script and the worker exits. This
  requires wiring the existing `abortController` into the init helper.
- **Timeout / `maxRuntimeSeconds`**: the init timeout is separate from and
  shorter than `maxRuntimeSeconds`. Init time counts against the session's
  overall runtime budget because it runs inside the same worker process, but
  the init-specific timeout fires first for a stuck script.
- **Refinement workers**: refinement launches use the same worker runtime
  and therefore the same init step. A repository's `yeetstrap.sh` runs before
  the refinement agent just as it runs before the implementation agent. This
  is intentional: refinement needs a buildable environment to test claims.
- **PR review workers**: same as refinement. The init script runs.

## Security Considerations

The init script is executable repository content. The threat model is the
same as for the agent: a malicious repository under a workspace mount can
already run arbitrary shell commands through the agent. The init step moves
the earliest point at which repository shell code executes from "first agent
tool call" to "before the agent starts," but it does not change what can be
executed.

Two properties are worth restating:

- The init script runs as the non-root worker user, with no GitHub
  credentials, no Docker socket, and no control-plane state access. It can
  only mutate the mounted workspace and reach the network.
- The init script is discovered by convention (`yeetstrap.sh`) and is
  overridable or skippable by the control plane. A maintainer who does not
  trust a repository's init script sets `YEETOMATIC_WORKER_INIT_SKIP=1` for
  that launch.

Because the workspace mount is shared across launches and across the
control plane, a malicious init script could persist artifacts that survive
its own container. This is already true of any agent tool call; the init
script does not widen this surface.

## Disabling

A maintainer disables the init step for a launch by setting
`YEETOMATIC_WORKER_INIT_SKIP=1` in the control-plane environment before the
worker is launched. The variable is forwarded to the worker, the worker
reads it before stats-ing the script, and the init phase is skipped
silently. The agent then starts against whatever environment the workspace
already has — the same behavior as today.

This is the escape hatch for:

- a broken init script that is preventing the agent from starting at all,
- debugging an environment that the init script keeps mutating in
  undesirable ways, and
- running the agent against a deliberately clean or deliberately broken
  environment to reproduce a bug.

## Example Init Scripts

Minimal Node project (`yeetstrap.sh`):

```bash
#!/usr/bin/env bash
set -euo pipefail
npm ci
```

Node project that tolerates a missing lockfile:

```bash
#!/usr/bin/env bash
set -euo pipefail
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
```

Monorepo that builds workspaces before the agent runs tests:

```bash
#!/usr/bin/env bash
set -euo pipefail
npm ci
npm run build --workspaces --if-present
```

Python project (requires `python3` added to the worker image):

```bash
#!/usr/bin/env bash
set -euo pipefail
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

A script that fails loudly when the environment is wrong, rather than
silently proceeding:

```bash
#!/usr/bin/env bash
set -euo pipefail
node --version
npm ci
npm run --silent typecheck
```

## Test Plan

Unit tests in `src/worker/env-init.test.ts` cover:

- script absent -> resolve to "skip", no spawn, no log.
- `YEETOMATIC_WORKER_INIT_SKIP=1` -> resolve to "skip", no spawn even when
  script exists.
- script present, exits 0 -> resolve, stdout/stderr framed as `event_batch`
  payloads with `details.type: "env_init"`.
- script present, exits non-zero -> reject with `EnvInitError` carrying exit
  code and stderr tail.
- script killed by signal -> reject with `EnvInitError` carrying signal name.
- timeout -> reject with `EnvInitError` of kind `timeout`, process killed.
- unreadable or empty script -> reject with `EnvInitError` of kind
  `invalid_script`.
- absolute `YEETOMATIC_WORKER_INIT_SCRIPT` -> used as-is.
- relative `YEETOMATIC_WORKER_INIT_SCRIPT` -> resolved against workspace path.
- abort signal fires during init -> script killed, rejection propagates.

Integration coverage in `src/worker/runtime.test.ts` extends the existing
runtime tests to assert that:

- a workspace with `yeetstrap.sh` runs the script before the executor is
  constructed,
- a workspace without `yeetstrap.sh` skips straight to the executor, and
- a failing init script causes the runtime to emit an `error` message and
  rethrow without constructing the executor.

`src/executor/docker-worker.test.ts` gains assertions that
`buildDockerRunArgs` forwards `YEETOMATIC_WORKER_INIT_*` variables when
present and omits them when absent.

Guardrail coverage for the new `src/worker/env-init.ts` must meet the 80%
threshold for statements, branches, functions, and lines, per the project's
`npm run guardrail:test` requirement.

## Open Questions

- Should the init phase emit a single structured `env_init_start` /
  `env_init_end` log line pair so the control plane can render a distinct
  "Preparing environment..." UI state? Current proposal: no, the
  `details.type: "env_init"` tag on the streamed `session_log` events is
  sufficient and avoids a new protocol surface. Revisit if a UI wants to
  show init progress separately from agent progress.
- Should the worker skip the init script on refinement-only launches where
  the refinement worktree is a fresh temporary checkout that will be
  discarded? Current proposal: no, run it anyway; refinement needs a
  buildable environment to test claims, and the cost is paid once per
  refinement attempt.
- Should `YEETOMATIC_WORKER_INIT_SCRIPT` support a `disabled` sentinel
  value in addition to `YEETOMATIC_WORKER_INIT_SKIP`? Current proposal: no,
  two mechanisms for the same thing is confusing; `SKIP` is the single
  off switch.