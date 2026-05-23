FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.json ./

RUN npm ci

COPY . .

RUN npm run build

# Runtime stage
FROM node:24-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV HOME=/home/tars
ENV PI_CODING_AGENT_DIR=/home/tars/.pi/agent
ENV SESSIONS_DIR=/app/sessions
ENV WORKSPACES_DIR=/app/workspaces
ENV MEMORY_DIR=/app/memory

# Install git (required for worktrees) and GitHub CLI
RUN apt-get update && apt-get install -y git curl gnupg \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Copy production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Create non-root user
RUN useradd --create-home --shell /bin/bash tars \
  && mkdir -p /home/tars/.pi/agent/sessions \
  && mkdir -p /app/sessions /app/workspaces /app/memory \
  && chown -R tars:tars /app /home/tars

# Copy build artifacts
COPY --from=build /app/dist ./dist

# Copy TARS extensions
COPY --chown=tars:tars --from=build /app/.pi ./.pi

# Copy config/context files
COPY --from=build /app/AGENTS.md ./AGENTS.md
COPY --from=build /app/SOUL.md ./SOUL.md
COPY --from=build /app/WORKSPACES.md ./WORKSPACES.md

# Copy models.json to agent directory
COPY --from=build /app/models.json /home/tars/.pi/agent/models.json

# Install pi packages (like CASE does)
RUN cd /app/.pi/npm \
  && npm install @ollama/pi-web-search || true

USER tars

EXPOSE 6767

CMD ["node", "./dist/index.js"]
