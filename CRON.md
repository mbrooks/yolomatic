# Auto-Update via Cron

TARS can auto-update itself from `origin/main` using the included script `scripts/update-tars-if-needed.sh`.

## What it does

- Polls `origin/main` for new commits
- Refuses to update if the working tree is dirty, the wrong branch is checked out, or the local branch has diverged (safety first)
- Fast-forwards `main` when updates are clean
- Runs `npm install` only when `package.json` or `package-lock.json` changed
- Rebuilds and restarts the stack with `docker compose up -d --build`

## Install

1. Make sure the script is executable:
   ```bash
   chmod +x scripts/update-tars-if-needed.sh
   ```

2. Open your crontab:
   ```bash
   crontab -e
   ```

3. Add an entry to run every 15 minutes (adjust path to your clone):
   ```cron
   */15 * * * * cd /opt/tars && ./scripts/update-tars-if-needed.sh >> /var/log/tars-update.log 2>&1
   ```

   Or with `SHELL` and `PATH` set for Docker and Node:
   ```cron
   SHELL=/bin/bash
   PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
   */15 * * * * cd /opt/tars && ./scripts/update-tars-if-needed.sh >> /var/log/tars-update.log 2>&1
   ```

## Post-restart checks

- TARS exposes port `6767`. After the script runs `docker compose up -d --build`, verify the container is healthy:
  ```bash
  docker ps --filter name=tars
  curl -f http://localhost:6767/webhook -X POST -H "X-GitHub-Event: ping" -d '{"zen":"Ping!"}'
  ```

## Notes

- **Data survives restarts.** Volumes `tars_sessions`, `tars_workspaces`, and `tars_pi` are mounted externally, so active sessions and workspace checkouts persist across container restarts.
- **In-flight webhooks may be interrupted.** GitHub retries most webhook deliveries automatically, but any currently running TARS session inside the container will be cut short during the restart.
