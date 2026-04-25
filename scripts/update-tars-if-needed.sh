#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BRANCH="main"
REMOTE="origin"

cd "${REPO_ROOT}"

echo "[$(date -Iseconds)] Checking ${REMOTE}/${BRANCH} for updates"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree has local changes. Refusing to auto-update."
  exit 1
fi

git fetch "${REMOTE}" "${BRANCH}"

LOCAL_COMMIT="$(git rev-parse HEAD)"
REMOTE_COMMIT="$(git rev-parse "${REMOTE}/${BRANCH}")"

if [[ "${LOCAL_COMMIT}" == "${REMOTE_COMMIT}" ]]; then
  echo "No updates available."
  exit 0
fi

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "${CURRENT_BRANCH}" != "${BRANCH}" ]]; then
  echo "Current branch is '${CURRENT_BRANCH}', expected '${BRANCH}'. Refusing to auto-update."
  exit 1
fi

if ! git merge-base --is-ancestor "${LOCAL_COMMIT}" "${REMOTE_COMMIT}"; then
  echo "Local branch has diverged from ${REMOTE}/${BRANCH}. Refusing to auto-update."
  exit 1
fi

BEFORE_LOCKSUM="$(shasum package-lock.json 2>/dev/null | awk '{print $1}')"
BEFORE_PKGSUM="$(shasum package.json 2>/dev/null | awk '{print $1}')"

git pull --ff-only "${REMOTE}" "${BRANCH}"

AFTER_LOCKSUM="$(shasum package-lock.json 2>/dev/null | awk '{print $1}')"
AFTER_PKGSUM="$(shasum package.json 2>/dev/null | awk '{print $1}')"

if [[ "${BEFORE_LOCKSUM}" != "${AFTER_LOCKSUM}" || "${BEFORE_PKGSUM}" != "${AFTER_PKGSUM}" ]]; then
  echo "Dependencies changed. Running npm install."
  npm install
fi

echo "Rebuilding and restarting via Docker Compose."
docker compose up -d --build

echo "[$(date -Iseconds)] Update complete"
