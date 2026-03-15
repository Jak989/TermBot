# TermBot Container Deployment (Server)

## 1) Prerequisites

- Docker Engine + Docker Compose plugin
- Open TCP port `8787` (only if Mini App should be reachable externally)

## 2) Clone the Project

```bash
git clone <REPO_URL>
cd TermBot
cp .env.example .env
```

## 3) Configure `.env` (Required)

Minimum:

- `TELEGRAM_BOT_TOKEN=...`
- `TELEGRAM_ALLOWED_USER_ID=...`

Recommended:

- `BOT_CODEX_BACKEND=tmux`
- `BOT_ENABLE_RESTART_COMMAND=1`
- `BOT_AUTO_START_CODEX=1`
- `BOT_SINGLE_INSTANCE=1`
- `BOT_RESTART_HEALTH_TIMEOUT_MS=15000`
- `BOT_RESTART_READY_FILE=data/runtime/restart-ready.json`

Optional:

- `OPENAI_API_KEY=...` (if you want non-interactive Codex auth)
- `BOT_WEBAPP_URL=https://...` (custom domain / reverse proxy)

## 4) Start the Container

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f termbot
```

## 5) Enable Codex in the Container

If you do not use `OPENAI_API_KEY` in `.env`:

```bash
docker compose exec termbot codex login --device-auth
```

Why `--device-auth`:

- Browser login relies on a `localhost` redirect.
- On headless systems, over SSH, or inside containers, that redirect is often unreachable or wrong.
- Device auth gives you a code + URL that you complete on your normal browser (desktop/phone).

Verify login:

```bash
docker compose exec termbot codex login status
```

Codex auth state persists in the Docker volume `codex_home`.

## 6) Health / Troubleshooting

Check Mini App endpoint inside the container:

```bash
docker compose exec termbot curl -fsS http://127.0.0.1:8787/telegram-miniapp/index.html | head
```

Restart flow test:

- Telegram command: `/restartbot`
- Expected result: bot restarts and auto-starts Codex
