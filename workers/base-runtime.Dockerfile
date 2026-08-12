FROM node:26-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:26-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV SESSIONS_DIR=/app/sessions
ENV WORKSPACES_DIR=/app/workspaces
ENV PATH="/app/node_modules/.bin:${PATH}"
ENV HOME=/home/yolomatic
ENV NPM_CONFIG_CACHE=/home/yolomatic/.npm
ENV PI_CODING_AGENT_DIR=/home/yolomatic/.pi/agent

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      ripgrep \
      sqlite3 \
      xxd \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app /app

RUN cd /app/.pi/npm \
  && npm install @ollama/pi-web-search || true \
  && useradd --create-home --shell /bin/bash yolomatic \
  && mkdir -p /home/yolomatic/.pi/agent/sessions /home/yolomatic/.npm /app/sessions /app/workspaces \
  && chown -R yolomatic:yolomatic /app /home/yolomatic

USER yolomatic

CMD ["node", "./dist/worker/entrypoint.js"]
