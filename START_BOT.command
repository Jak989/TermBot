#!/bin/zsh
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
DATA_DIR="$PROJECT_DIR/data"
CLOUDFLARED_LOG="$DATA_DIR/cloudflared.log"
CLOUDFLARED_PID="$DATA_DIR/cloudflared.pid"

mkdir -p "$DATA_DIR"
cd "$PROJECT_DIR"

set_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i '' "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

cleanup() {
  if [[ -f "$CLOUDFLARED_PID" ]]; then
    local pid
    pid="$(cat "$CLOUDFLARED_PID" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$CLOUDFLARED_PID"
  fi
}

trap cleanup EXIT INT TERM

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared nicht gefunden. Bitte zuerst installieren:"
  echo "  brew install cloudflared"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm nicht gefunden. Bitte Node.js/npm installieren."
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$PROJECT_DIR/.env.example" ]]; then
    cp "$PROJECT_DIR/.env.example" "$ENV_FILE"
  else
    echo ".env fehlt und .env.example wurde nicht gefunden."
    exit 1
  fi
fi

TOKEN="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$ENV_FILE" | head -n1)"
USER_ID="$(sed -n 's/^TELEGRAM_ALLOWED_USER_ID=//p' "$ENV_FILE" | head -n1)"

if [[ -z "${TOKEN}" || -z "${USER_ID}" ]]; then
  echo "Bitte zuerst TELEGRAM_BOT_TOKEN und TELEGRAM_ALLOWED_USER_ID in .env setzen."
  echo "Datei: $ENV_FILE"
  exit 1
fi

# Old tunnel cleanup (if pid file exists)
if [[ -f "$CLOUDFLARED_PID" ]]; then
  old_pid="$(cat "$CLOUDFLARED_PID" 2>/dev/null || true)"
  if [[ -n "${old_pid}" ]] && kill -0 "$old_pid" 2>/dev/null; then
    kill "$old_pid" >/dev/null 2>&1 || true
    sleep 1
  fi
  rm -f "$CLOUDFLARED_PID"
fi

# Extra cleanup for stale processes not tracked by pid file
if command -v pkill >/dev/null 2>&1; then
  pkill -f "cloudflared tunnel --url http://127.0.0.1:8787" >/dev/null 2>&1 || true
  pkill -f "scripts/termbot-supervisor.js" >/dev/null 2>&1 || true
  pkill -f "$PROJECT_DIR/bot.js" >/dev/null 2>&1 || true
fi

: > "$CLOUDFLARED_LOG"
nohup cloudflared tunnel --url http://127.0.0.1:8787 > "$CLOUDFLARED_LOG" 2>&1 &
CLOUDFLARED_BG_PID="$!"
echo "$CLOUDFLARED_BG_PID" > "$CLOUDFLARED_PID"

TUNNEL_URL=""
for _ in {1..40}; do
  if ! kill -0 "$CLOUDFLARED_BG_PID" 2>/dev/null; then
    echo "cloudflared ist unerwartet beendet."
    tail -n 60 "$CLOUDFLARED_LOG" || true
    exit 1
  fi

  TUNNEL_URL="$(rg -o 'https://[a-z0-9-]+\.trycloudflare\.com' -m1 "$CLOUDFLARED_LOG" || true)"
  if [[ -n "${TUNNEL_URL}" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "${TUNNEL_URL}" ]]; then
  echo "Konnte keine trycloudflare URL ermitteln."
  tail -n 60 "$CLOUDFLARED_LOG" || true
  exit 1
fi

set_env "BOT_WEBAPP_URL" "$TUNNEL_URL"
set_env "BOT_WEBAPP_ENABLE" "1"
set_env "BOT_WEBAPP_AUTO_MENU" "1"
set_env "BOT_WEB_PORT" "8787"
set_env "BOT_WEB_HOST" "127.0.0.1"
set_env "BOT_AUTO_START_CODEX" "1"
set_env "BOT_STARTUP_SEND_PANEL" "1"
set_env "BOT_STARTUP_BOOT_DELAY_MS" "1500"

echo ""
echo "Tunnel aktiv: $TUNNEL_URL"
echo ".env aktualisiert."
echo "Starte Bot..."
echo ""

npm run start
