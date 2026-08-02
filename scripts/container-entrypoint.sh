#!/bin/sh
set -eu

# Named volumes retain ownership across image upgrades. Repair state created by
# older root-running releases before dropping privileges for the control plane.
mkdir -p /app/sessions /app/workspaces /app/memory /app/runtime /home/yeetomatic/.pi/agent
chown -R yeetomatic:yeetomatic /app/sessions /app/workspaces /app/memory /app/runtime /home/yeetomatic/.pi/agent

# Grant the non-root `yeetomatic` runtime user access to the host Docker socket
# mounted at /var/run/docker.sock. The owning group of the mounted socket is
# platform-dependent: on a standard Linux host it is the `docker` group
# (commonly GID 999, also supplied via the DOCKER_GID env var / group_add), but
# on macOS Docker Desktop the bind-mounted socket is frequently owned by a
# group that is NOT 999 (commonly root/GID 0). Rather than assuming a fixed
# GID, derive access from the socket's actual owning group so both platforms
# work with `docker compose up --build -d` and no manual DOCKER_GID/chmod.
DOCKER_SOCKET="/var/run/docker.sock"
if [ -S "$DOCKER_SOCKET" ]; then
	SOCKET_GID="$(stat -c %g "$DOCKER_SOCKET")"
	# Ensure a group with the socket's GID exists. Reuse an existing group that
	# already has that GID if present; otherwise create a named one.
	EXISTING_GROUP="$(getent group "$SOCKET_GID" | cut -d: -f1 || true)"
	if [ -n "$EXISTING_GROUP" ]; then
		SOCKET_GROUP="$EXISTING_GROUP"
	else
		SOCKET_GROUP="docker-socket"
		if ! getent group "$SOCKET_GROUP" >/dev/null 2>&1; then
			groupadd -g "$SOCKET_GID" "$SOCKET_GROUP"
		else
			# Name collision with a group of a different GID; fall back to a
			# unique name so we can still pin the required GID.
			SOCKET_GROUP="docker-socket-$SOCKET_GID"
			groupadd -g "$SOCKET_GID" "$SOCKET_GROUP"
		fi
	fi
	if ! id -nG yeetomatic | tr ' ' '\n' | grep -qx "$SOCKET_GROUP"; then
		usermod -aG "$SOCKET_GROUP" yeetomatic
	fi
fi

exec runuser -u yeetomatic -- "$@"