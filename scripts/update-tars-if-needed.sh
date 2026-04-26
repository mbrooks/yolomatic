#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BRANCH="main"
REMOTE="origin"

cd "${REPO_ROOT}"

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

echo "Rebuilding and restarting via Docker Compose."
docker compose up -d --build

echo "[$(date -Iseconds)] Update complete"
