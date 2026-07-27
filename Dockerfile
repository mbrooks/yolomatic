FROM node:24-bookworm-slim AS build

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

RUN apt-get update && apt-get install -y ca-certificates git curl gnupg sqlite3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app /app
COPY scripts/container-entrypoint.sh /usr/local/bin/yeetomatic-container-entrypoint

RUN cd /app/.pi/npm \
  && npm install @ollama/pi-web-search || true

RUN useradd --create-home --shell /bin/bash yeetomatic \
  && mkdir -p /home/yeetomatic/.pi/agent/sessions \
  && mkdir -p /app/sessions /app/workspaces /app/memory \
  && chown -R yeetomatic:yeetomatic /app /home/yeetomatic

RUN chmod 0755 /usr/local/bin/yeetomatic-container-entrypoint

FROM base-runtime AS worker

ENV HOME=/home/yeetomatic
ENV PI_CODING_AGENT_DIR=/home/yeetomatic/.pi/agent

USER yeetomatic

CMD ["node", "./dist/worker/entrypoint.js"]

# Runtime stage
FROM base-runtime AS runtime

ENV HOME=/home/yeetomatic
ENV PI_CODING_AGENT_DIR=/home/yeetomatic/.pi/agent

# Install GitHub CLI and Docker CLI for the control plane container
RUN apt-get update && apt-get install -y gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Create docker group for socket access
RUN groupadd -g 999 docker \
  && usermod -aG docker yeetomatic \
  && chown -R yeetomatic:yeetomatic /app /home/yeetomatic

ENTRYPOINT ["yeetomatic-container-entrypoint"]

EXPOSE 6767

CMD ["node", "./dist/index.js"]
