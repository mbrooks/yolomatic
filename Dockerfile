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

# Install git (required for worktrees)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Copy production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Create non-root user
RUN useradd --create-home --shell /bin/bash tars \
  && mkdir -p /home/tars/.pi/agent/sessions \
  && mkdir -p /app/sessions /app/workspaces \
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
