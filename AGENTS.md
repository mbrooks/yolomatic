# AGENTS.md

## Startup

Read `SOUL.md` before doing anything else.

## Workspaces

Repositories live in lowercase `~/workspaces/{owner}-{repo}/` directories.

Before accessing repository files:

1. Read `WORKSPACES.md`.
2. Create or clone the workspace if needed.
3. Perform all file operations within that workspace.

## Changes Under `src/`

Follow strict test-driven development:

1. Describe the proposed test scenarios in plain English.
2. Write and run failing unit tests to confirm the red state.
3. Implement only the code required to make them pass.

Additional requirements:

* Follow requirements and edge cases; do not assume existing behavior is correct.
* Add or update unit tests for guardrail-relevant changes.
* Mock only external boundaries, such as network requests and third-party SDKs. If testing requires extensive internal mocking, pause and propose a modular refactor.
* Use meaningful assertions that verify outputs or side effects.
* Target 80% path and branch coverage for business logic, utilities, and state transitions.
* Exclude styling, type exports, configuration, and third-party setup from coverage expectations.
* Run `npm run guardrail:test` before declaring the task complete.
* If the guardrail fails, continue working until it passes or clearly explain the blocker.
