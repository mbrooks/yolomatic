# Auto-Update via Cron

Yolomatic can auto-update itself from `origin/main` using the included script `scripts/update-yolomatic-if-needed.sh`.

## What it does

- Polls `origin/main` for new commits
- Refuses to update if the working tree is dirty, the wrong branch is checked out, or the local branch has diverged (safety first)
- Fast-forwards `main` when updates are clean
- Runs `npm install` only when `package.json` or `package-lock.json` changed
- Rebuilds and restarts the stack with `docker compose up -d --build`

## Install

1. Make sure the script is executable:
   ```bash
   chmod +x scripts/update-yolomatic-if-needed.sh
   ```

2. Open your crontab:
   ```bash
   crontab -e
   ```

3. Add an entry to run every 15 minutes (adjust path to your clone):
   ```cron
   */15 * * * * cd /opt/yolomatic && ./scripts/update-yolomatic-if-needed.sh >> /var/log/yolomatic-update.log 2>&1
   ```

   Or with `SHELL` and `PATH` set for Docker and Node:
   ```cron
   SHELL=/bin/bash
   PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
   */15 * * * * cd /opt/yolomatic && ./scripts/update-yolomatic-if-needed.sh >> /var/log/yolomatic-update.log 2>&1
   ```

## Post-restart checks

- Yolomatic exposes port `6767`. After the script runs `docker compose up -d --build`, verify the container is healthy:
  ```bash
  docker ps --filter name=yolomatic
  curl -f http://localhost:6767/webhook -X POST -H "X-GitHub-Event: ping" -d '{"zen":"Ping!"}'
  ```

## Notes

- **Data survives restarts.** Volumes `yolomatic_sessions`, `yolomatic_workspaces`, and `yolomatic_pi` are mounted externally, so active sessions and workspace checkouts persist across container restarts.
- **In-flight webhooks may be interrupted.** GitHub retries most webhook deliveries automatically, but any currently running Yolomatic session inside the container will be cut short during the restart.
