# pi-coding-agent

Autonomous GitHub issue polling agent for `mbrooks/tars`.

## Features

- Polls GitHub issues on a schedule
- Picks up one issue at a time
- Applies workflow labels and comments
- Delegates issue execution to `@mariozechner/pi-coding-agent`
- Creates pull requests when execution completes

## Setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env`
3. Fill in the GitHub and PI agent environment variables
4. Run locally with `npm run dev`

## Workflow

1. Fetch open issues that do not already need clarification or active work.
2. Mark the issue with the working label and post a pickup comment.
3. Execute the issue task through the PI coding agent adapter.
4. If clarification is needed, switch labels and post the question.
5. If complete, create a PR, label the issue, and post the PR URL.
