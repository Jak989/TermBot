#!/usr/bin/env bash
set -euo pipefail

cd /app

if [[ -f /app/.env ]]; then
  echo "[entrypoint] using /app/.env"
else
  echo "[entrypoint] no /app/.env found (continuing with env vars only)"
fi

# Surface key tool versions for quick diagnostics in container logs.
echo "[entrypoint] node: $(node -v)"
echo "[entrypoint] npm: $(npm -v)"
echo "[entrypoint] tmux: $(tmux -V | head -n 1)"
echo "[entrypoint] codex: $(codex --version 2>/dev/null || echo 'not available')"

exec node scripts/termbot-supervisor.js
