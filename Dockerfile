FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV TZ=Europe/Berlin
ENV BOT_CWD=/app
ENV CODEX_HOME=/root/.codex

WORKDIR /app

# Base tools:
# - tmux: required by BOT_CODEX_BACKEND=tmux
# - build-essential: required to compile native Node modules such as node-pty
# - python3: optional voice transcription helper dependency
# - curl/ca-certificates: health checks and runtime probes
# - tini: clean signal forwarding for container shutdown
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    python3 \
    tmux \
    tzdata \
    tini \
  && rm -rf /var/lib/apt/lists/*

# Install cloudflared binary (quick tunnel support for BOT_WEBAPP_URL auto-restore).
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) cf_arch="amd64" ;; \
    arm64) cf_arch="arm64" ;; \
    *) echo "Unsupported architecture for cloudflared: $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cf_arch}" \
    -o /usr/local/bin/cloudflared; \
  chmod +x /usr/local/bin/cloudflared; \
  cloudflared --version

# Install Codex CLI globally inside the container.
RUN npm install -g @openai/codex

# Install app dependencies first for better build cache usage.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy runtime sources.
COPY bot.js ./bot.js
COPY V3_PERSONALITY.md ./V3_PERSONALITY.md
COPY public ./public
COPY scripts ./scripts
COPY data/.gitkeep ./data/.gitkeep
RUN mkdir -p /app/data /root/.codex

COPY docker/entrypoint.sh /usr/local/bin/termbot-entrypoint
RUN chmod +x /usr/local/bin/termbot-entrypoint

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/telegram-miniapp/index.html >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/termbot-entrypoint"]
