#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BRANCH="main"
REMOTE="origin"

API_BASE="http://localhost:${PORT:-3000}"
ADMIN_USER="${ADMIN_USERNAME:-}"
ADMIN_PASS="${ADMIN_PASSWORD:-}"
SLEEP_DURATION="${SLEEP_DURATION:-30}"
MAX_TRIES="${MAX_TRIES:-120}"

cd "${REPO_ROOT}"

if [[ -z "${SKIP_GIT:-}" ]]; then
	echo "[$(date -Iseconds)] Checking ${REMOTE}/${BRANCH} for updates"

	BEFORE_COMMIT="$(git rev-parse HEAD)"

	git fetch "${REMOTE}" "${BRANCH}"

	# Discard any local changes and reset to the target branch
	git checkout -f -B "${BRANCH}" "${REMOTE}/${BRANCH}"

	AFTER_COMMIT="$(git rev-parse HEAD)"

	if [[ "${BEFORE_COMMIT}" == "${AFTER_COMMIT}" ]]; then
		echo "No updates available."
		exit 0
	fi

	echo "Reset to ${REMOTE}/${BRANCH} (${AFTER_COMMIT}). Checking for dependency changes..."

	DEP_DIFF=0
	git diff --quiet "${BEFORE_COMMIT}" "${AFTER_COMMIT}" -- package-lock.json package.json || DEP_DIFF=$?
	if [[ "${DEP_DIFF}" -ne 0 ]]; then
		echo "Dependencies changed. Running npm install."
		npm install
	fi
else
	echo "[$(date -Iseconds)] Git check skipped (SKIP_GIT=1)"
fi

# Drain working sessions before deploying
if [[ -n "$ADMIN_USER" && -n "$ADMIN_PASS" ]]; then
  echo "Entering maintenance mode..."
  curl -sf -u "${ADMIN_USER}:${ADMIN_PASS}" -X POST "${API_BASE}/api/maintenance" \
    -H "Content-Type: application/json" \
    -d '{"enabled":true}' > /dev/null 2>&1 || true

  TRIES=0
  while true; do
    RESPONSE=$(curl -sf -u "${ADMIN_USER}:${ADMIN_PASS}" "${API_BASE}/api/status/working" 2>/dev/null || true)
    if [[ -z "$RESPONSE" ]]; then
      echo "Warning: could not reach TARS status API. Proceeding with deploy."
      break
    fi

    if echo "$RESPONSE" | grep -q '"working":false'; then
      echo "No working sessions. Proceeding with deploy."
      break
    fi

    TRIES=$((TRIES + 1))
    if [[ "$TRIES" -ge "$MAX_TRIES" ]]; then
      echo "Max attempts ($MAX_TRIES) reached. Proceeding with deploy anyway."
      break
    fi

    echo "Working sessions active. Waiting ${SLEEP_DURATION}s... (attempt $TRIES/$MAX_TRIES)"
    sleep "${SLEEP_DURATION}"
  done
else
  echo "Admin credentials not configured. Skipping working-session drain check."
fi

echo "Rebuilding and restarting via Docker Compose."
if [[ -z "${SKIP_DOCKER:-}" ]]; then
	docker compose up -d --build
else
	echo "Docker step skipped (SKIP_DOCKER=1)"
fi

echo "[$(date -Iseconds)] Update complete"
