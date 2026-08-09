#!/usr/bin/env bash
# yolostrap.sh - worker environment initialization for the yolomatic project.
#
# Yolomatic runs this script inside the disposable worker container before
# the agent starts, so the workspace is in a known state before the first
# model turn. See design/worker-env-init.md for the full contract.
#
# The worker image (node:24-bookworm-slim based) has no root and no apt-get
# cache, so this script is limited to user-writable tooling: npm/pnpm/cargo
# installs, lock file generation, native extensions that need no system
# headers, etc. System package requirements belong in the worker Dockerfile
# target, not here.
#
# The workspace mount is shared across worker launches, so anything this
# script writes (including node_modules) persists across sessions for this
# repository. The first worker pays the install cost; later workers detect a
# warm environment and exit near-instantly.
set -euo pipefail

# Materialize Node dependencies so the agent can run tests, builds, and lint
# without spending model turns on `npm install`.
if [ -f package-lock.json ]; then
	npm ci
elif [ -f package.json ]; then
	npm install
fi