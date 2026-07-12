#!/bin/sh
set -eu

# Named volumes retain ownership across image upgrades. Repair state created by
# older root-running releases before dropping privileges for the control plane.
mkdir -p /app/sessions /app/workspaces /app/memory /app/runtime /home/tars/.pi/agent
chown -R tars:tars /app/sessions /app/workspaces /app/memory /app/runtime /home/tars/.pi/agent

exec runuser -u tars -- "$@"
