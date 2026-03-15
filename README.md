# TermBot V0.2 (Schenni)

TermBot is a local Telegram bot that controls your terminal and a persistent Codex session on your machine.  
Instead of just sending commands, you collaborate with an assistant in chat.

> Note: Community project. Not officially affiliated with OpenAI, Telegram, or Slack.

## Table of Contents

- [1. What TermBot Does](#1-what-termbot-does)
- [2. Architecture at a Glance](#2-architecture-at-a-glance)
- [3. Prerequisites](#3-prerequisites)
- [4. Quick Start (Local)](#4-quick-start-local)
- [5. Environment Configuration](#5-environment-configuration)
- [6. Telegram Commands](#6-telegram-commands)
- [7. Local CLI Commands](#7-local-cli-commands)
- [8. Mini App and Tunnel](#8-mini-app-and-tunnel)
- [9. Personality and Memory](#9-personality-and-memory)
- [10. Voice Transcription](#10-voice-transcription)
- [11. Notion Sync (Optional)](#11-notion-sync-optional)
- [12. Operations](#12-operations)
- [13. Tests and Diagnostics](#13-tests-and-diagnostics)
- [14. Troubleshooting](#14-troubleshooting)
- [15. Security](#15-security)
- [16. Project Structure](#16-project-structure)
- [17. GitHub Release Flow](#17-github-release-flow)
- [18. License and Trademarks](#18-license-and-trademarks)

## 1. What TermBot Does

- Controls local shell commands and Codex sessions via Telegram.
- Keeps a persistent Codex session using `tmux`.
- Smart mix routing: normal chat input goes to Codex; `/sh` is explicit shell.
- Provides a Mini App command center with live output, events, and runtime status.
- Includes reminders and productivity helpers (timer, one-time reminders, daily reminders).
- Applies a user profile and persona overlay from `V3_PERSONALITY.md`.
- Optional Notion sync (API or MCP).
- Optional voice message transcription into normal text input.

## 2. Architecture at a Glance

- [bot.js](./bot.js): main process, Telegram handling, runtime orchestration, reminders, Mini App API
- [scripts/termbot-supervisor.js](./scripts/termbot-supervisor.js): supervisor entrypoint (`npm run start`)
- [scripts/codexbot-daemon.js](./scripts/codexbot-daemon.js): long-lived daemon for Codex runs
- [scripts/codexbot-cli.js](./scripts/codexbot-cli.js): local control (`bot start|stop|status|ask|...`)
- [public/telegram-miniapp/](./public/telegram-miniapp): Mini App UI
- `data/`: runtime files (events, state, profile, reminders)

## 3. Prerequisites

- Node.js 22+ (recommended)
- `npm`
- `tmux`
- Telegram bot token from BotFather
- Your Telegram user ID for allowlisting
- Optional: `cloudflared` for tunnel
- Optional: `python3` + OpenAI API key for voice transcription

## 4. Quick Start (Local)

```bash
npm install
cp .env.example .env
```

Set at least these values in `.env`:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID`
- `BOT_CWD` (absolute path to this repo)
- `CODEX_HOME` (absolute path to your `.codex`)
- `CODEX_CWD` (absolute path to this repo)

Start:

```bash
npm run start
```

## 5. Environment Configuration

Recommended stable defaults:

- `BOT_CODEX_BACKEND=tmux`
- `BOT_CODEX_MODEL=gpt-5.4`
- `BOT_CODEX_REASONING_EFFORT=standard` (`high` or `standard`)
- `BOT_AUTO_START_CODEX=1`
- `BOT_PROMPT_ON_START=1`
- `BOT_SINGLE_INSTANCE=1`
- `BOT_ENABLE_RESTART_COMMAND=1`
- `BOT_RESTART_HEALTH_TIMEOUT_MS=15000`
- `BOT_RESTART_READY_FILE=data/runtime/restart-ready.json`
- `BOT_CHAT_TYPING_ACTION=1`
- `BOT_CHAT_SEND_THINKING_MARKER=1`

Persona/profile:

- `BOT_PERSONALITY_AUTO_APPLY=1`
- `BOT_PERSONALITY_FILE=V3_PERSONALITY.md`
- `BOT_PERSONALITY_MAX_CHARS=12000`
- `BOT_PREFERENCE_LEARNING=1`
- `BOT_PREFERENCE_LEARNING_MAX_HINTS=20`

Mini App:

- `BOT_WEBAPP_ENABLE=1`
- `BOT_WEB_PORT=8787`
- `BOT_WEB_HOST=127.0.0.1`
- `BOT_WEBAPP_URL=https://...` (fixed URL recommended)

## 6. Telegram Commands

Primary commands:

- `/startcodex` start Codex session
- `/stopcodex` stop active Codex session
- `/livecodex` open Live panel (`/panel` alias)
- `/restartbot` restart bot process

Legacy aliases still accepted:

- `/codexstart` alias for `/startcodex`
- `/panel` alias for `/livecodex`

Advanced commands (supported):

- `/status` runtime status
- `/sh <command>` explicit shell command
- `/setupassistant` profile setup wizard
- `/timer`, `/remind`, `/daily`, `/reminders`, `/remindoff`

## 7. Local CLI Commands

```bash
npm run bot:start
npm run bot:status
npm run bot:ask -- "Say only OK"
npm run bot:new
npm run bot:cancel
npm run bot:logs
npm run bot:stop
```

Direct start without supervisor:

```bash
npm run bot:direct
```

## 8. Mini App and Tunnel

Local Mini App URL:

- `http://127.0.0.1:8787/telegram-miniapp/index.html`

Cloudflare tunnel modes:

- `BOT_CLOUDFLARE_TUNNEL_MODE=auto` (default)
- `named` for stable custom domain
- `quick` for temporary TryCloudflare URL
- `off` to disable bot-managed tunnel

Recommended for production:

- `BOT_CLOUDFLARE_TUNNEL_MODE=named`
- `BOT_CLOUDFLARE_TUNNEL_NAME=termbot`
- `BOT_WEBAPP_URL=https://bot.example.com`

One-time named tunnel setup:

```bash
cloudflared tunnel login
cloudflared tunnel create termbot
cloudflared tunnel route dns termbot bot.example.com
```

## 9. Personality and Memory

- `/setupassistant` stores user profile in `data/user-profile.json`.
- Profile block is synchronized into `V3_PERSONALITY.md`.
- New Codex sessions auto-inject this profile.
- Chat-derived preference hints are optionally stored when `BOT_PREFERENCE_LEARNING=1`.

## 10. Voice Transcription

- Enable with `BOT_VOICE_ENABLED=1`
- Max duration with `BOT_VOICE_MAX_DURATION_SEC=240`
- Default script: `$CODEX_HOME/skills/transcribe/scripts/transcribe_diarize.py`
- Model: `BOT_VOICE_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe`

Flow:

1. Receive voice/audio
2. Transcribe
3. Process transcript as normal chat input

## 11. Notion Sync (Optional)

- Enable with `NOTION_SYNC_ENABLED=1`
- Mode: `NOTION_SYNC_MODE=auto` (API if token exists, else MCP)
- Mode: `NOTION_SYNC_MODE=api`
- Mode: `NOTION_SYNC_MODE=mcp`

For API mode set:

- `NOTION_API_TOKEN`
- `NOTION_DATABASE_ID`

## 12. Operations

One-click start (macOS):

```bash
./START_BOT.command
```

PM2 (optional):

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Docker/server deployment:

- See [docs/CONTAINER_DEPLOY.md](./docs/CONTAINER_DEPLOY.md)

Quick start:

```bash
docker compose up -d --build
docker compose logs -f termbot
docker compose ps
```

## 13. Tests and Diagnostics

```bash
npm test
npm run test:miniapp
npm run test:runtime
npm run test:chat-output
npm run bot:doctor
npm run bot:doctor -- --fix
```

Restart smoke test (requires running supervisor):

```bash
npm run bot:restart-test
```

## 14. Troubleshooting

`A session is already running`:

1. Check with `/status`
2. Stop with `/stopcodex`
3. Start again with `/startcodex`

Mini App not reachable:

1. Verify `BOT_WEBAPP_ENABLE=1`
2. Verify `BOT_WEB_PORT` and `BOT_WEB_HOST`
3. Call `/livecodex` (or `/panel`)
4. Check logs via `npm run bot:logs`

Codex does not start:

1. Check local auth with `codex login status`
2. Use `codex login --device-auth` on headless/container systems
3. In container: `docker compose exec termbot codex login --device-auth`
4. Verify: `docker compose exec termbot codex login status`
5. Verify `CODEX_HOME` and `CODEX_CWD`
6. Verify `tmux` availability
7. Run `npm run bot:doctor`

Why `--device-auth`:

- Browser login uses a `localhost` callback.
- On servers/SSH/containers, that callback is often unreachable or lands in the wrong place.
- Device auth gives you a code + URL you can complete on your normal browser.

## 15. Security

- Telegram access restricted via `TELEGRAM_ALLOWED_USER_ID`.
- Mini App requests validated via Telegram `initData`.
- API endpoints are local by default (`BOT_WEB_HOST=127.0.0.1`).
- Live/input endpoints are rate-limited.
- Never commit secrets; keep them in `.env`.
- Runtime state is local in `data/`.

## 16. Project Structure

```text
.
|- bot.js
|- V3_PERSONALITY.md
|- scripts/
|  |- termbot-supervisor.js
|  |- codexbot-daemon.js
|  |- codexbot-cli.js
|  |- bot-doctor.js
|  `- tests/
|- public/telegram-miniapp/
|- docs/
|  |- CONTAINER_DEPLOY.md
|  |- GITHUB_PUBLISH_CHECKLIST.md
|  `- RELEASE_v1.0.1-restart-hotfix.md
`- data/
```

## 17. GitHub Release Flow

Recommended sequence:

1. Run checks (`npm test`, `npm run bot:doctor`)
2. Run secret scan (see [docs/GITHUB_PUBLISH_CHECKLIST.md](./docs/GITHUB_PUBLISH_CHECKLIST.md))
3. Create commit
4. Push branch and open PR

## 18. License and Trademarks

- There is currently no `LICENSE` file in the repo.
- `OpenAI`, `Codex`, `Telegram`, and `Slack` are trademarks of their respective owners.
- Mentioned only for compatibility/integration context.
