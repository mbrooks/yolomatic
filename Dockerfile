FROM node:26-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.json ./

RUN npm ci

COPY . .

RUN npm run build

FROM node:24-bookworm-slim AS base-runtime

WORKDIR /app

ENV NODE_ENV=production
ENV SESSIONS_DIR=/app/sessions
ENV WORKSPACES_DIR=/app/workspaces
ENV MEMORY_DIR=/app/memory
ENV PATH="/app/node_modules/.bin:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      curl \
      gnupg \
      sqlite3 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app /app
COPY scripts/container-entrypoint.sh /usr/local/bin/yeetomatic-container-entrypoint

# This installation runs as root, but /app is re-owned below.
RUN cd /app/.pi/npm \
  && npm install @ollama/pi-web-search || true

RUN useradd --create-home --shell /bin/bash yeetomatic \
  && mkdir -p \
      /home/yeetomatic/.pi/agent/sessions \
      /home/yeetomatic/.npm \
      /app/sessions \
      /app/workspaces \
      /app/memory \
  && chown -R yeetomatic:yeetomatic \
      /app \
      /home/yeetomatic \
  && chmod 0755 /usr/local/bin/yeetomatic-container-entrypoint

# All runtime npm operations use a cache owned by yeetomatic.
ENV HOME=/home/yeetomatic
ENV NPM_CONFIG_CACHE=/home/yeetomatic/.npm
ENV PI_CODING_AGENT_DIR=/home/yeetomatic/.pi/agent

FROM base-runtime AS worker

USER yeetomatic

CMD ["node", "./dist/worker/entrypoint.js"]


# Control-plane runtime stage
FROM base-runtime AS runtime

# Install GitHub CLI and Docker CLI before switching to yeetomatic.
RUN install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg \
      -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
      gh \
      docker-ce-cli \
  && rm -rf /var/lib/apt/lists/*

# Grant yeetomatic access to a Docker socket owned by GID 999.
RUN groupadd -g 999 docker \
  && usermod -aG docker yeetomatic \
  && chown -R yeetomatic:yeetomatic /app /home/yeetomatic

# NOTE: no `USER yeetomatic` here. The entrypoint runs as root so it can
# repair named-volume ownership and grant access to the mounted Docker socket,
# then drops privileges itself via `exec runuser -u yeetomatic -- "$@"`.
ENTRYPOINT ["yeetomatic-container-entrypoint"]

EXPOSE 6767

CMD ["node", "./dist/index.js"]