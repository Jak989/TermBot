# TermBot

TermBot ist ein Telegram-Bot fuer dein lokales Terminal, der gleichzeitig als persoenlicher Assistant arbeitet.

Der entscheidende Unterschied: **Sobald Codex laeuft, unterhaeltst du dich im Chat mit deinem Assistant** und laesst ihn Aufgaben erledigen, statt nur rohe Shell-Kommandos zu schicken.

> Hinweis: TermBot ist ein unabhaengiges Open-Source-Projekt und **nicht** mit OpenAI oder Telegram verbunden, gesponsert oder offiziell endorsed.

## Was TermBot besonders macht

- Terminal-Steuerung per Telegram fuer deinen lokalen Rechner
- Optionaler Slack-Bridge-Modus (Socket Mode)
- Assistant-Modus ueber Codex fuer echte Zusammenarbeit im Chat
- Eigene Persoenlichkeit pro User (`/setupassistant`)
- Merkt sich deine Vorlieben dauerhaft (Name, Ton, Preferences)
- Reminder, Daily-Routinen und Projekt-Kontext in einem Bot
- Mini-App Command Center mit Live-Ausgabe, Events und Systemstatus

## Der Bot im Alltag

Nach `/codexstart` oder `/ask <text>` nutzt du TermBot wie einen Assistant:

- "Plane meinen Tag und setze mir 2 Erinnerungen"
- "Fasse meine offenen Tasks zusammen"
- "Erstelle mir die naechsten 3 Schritte fuer dieses Projekt"
- "Erinnere mich taeglich 09:00 an den Terminal-Check"

Du chattest normal weiter, und TermBot arbeitet die Aufgaben in der laufenden Session ab.

## Persoenlichkeit und Memory

Mit `/setupassistant` konfigurierst du:

- deinen Namen
- den Namen des Assistants
- Kommunikationsstil (formal/leger/custom)
- eigene Preferences

TermBot speichert das lokal in `data/user-profile.json` und synchronisiert den Profilblock in `V3_PERSONALITY.md`.
Bei neuen Codex-Sessions wird dieses Profil automatisch als Verhalten geladen (konfigurierbar ueber `BOT_PERSONALITY_AUTO_APPLY`).

## Feature Matrix

| Bereich | Was du bekommst |
|---|---|
| Terminal Control | Shell/Terminal-Steuerung aus Telegram im Idle-Modus |
| Codex Assistant | Interaktive, persistente Codex-Session via tmux |
| Chat Collaboration | Normale Chat-Nachrichten werden waehrend Codex-Lauf als Input verarbeitet |
| Productivity | `/timer`, `/remind`, `/daily`, `/terminal`, `/reminders`, `/remindoff` |
| Project Context | `/projects` fuer letzte Projektkontexte und Restore |
| Mini App | Tabs fuer Coding, Raw, Events, System + direkte Eingaben |
| Voice | Audio/Voice -> Transkript -> Verarbeitung wie Text |
| Notion Sync (optional) | Aktivitaeten als Notion-Eintraege (API oder MCP) |
| Slack (optional) | Socket-Mode Steuerung mit denselben Core-Commands |

## Kern-Kommandos

- `/start` Hilfe und Startpanel
- `/setupassistant` Assistant-Profil einrichten
- `/codexstart` Codex-Session starten
- `/ask <text>` Prompt direkt an Codex
- `/projects` letzte Projekte/Sessions
- `/panel` Mini-App Button senden
- `/panelstatus` Mini-App/Tunnel/API Status
- `/status`, `/pwd`, `/stopcodex`, `/cancel`
- `/timer`, `/remind`, `/daily`, `/terminal`, `/reminders`, `/remindoff`

## Quick Start

```bash
npm install
cp .env.example .env
npm run start
```

Mindestens setzen in `.env`:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID`
- `BOT_CWD=/absoluter/pfad/zum/projekt`

Empfohlen fuer vollen Assistant-Betrieb:

- `BOT_CODEX_BACKEND=tmux`
- `BOT_AUTO_START_CODEX=1`
- `BOT_PROMPT_ON_START=1`
- `BOT_SINGLE_INSTANCE=1`
- `BOT_RESTART_HEALTH_TIMEOUT_MS=15000`
- `BOT_RESTART_READY_FILE=data/runtime/restart-ready.json`
- `BOT_PERSONALITY_AUTO_APPLY=1`
- `CODEX_YOLO=0` (sicherer Default)
- `BOT_WEBAPP_ENABLE=1`
- `BOT_WEBAPP_URL=https://...` (feste Domain fuer Mini-App)
- `BOT_CLOUDFLARE_TUNNEL_MODE=named`
- `BOT_CLOUDFLARE_TUNNEL_NAME=<dein-tunnel-name>`

### Cloudflare Tunnel Modi

`BOT_CLOUDFLARE_TUNNEL_MODE` steuert den Tunnel-Betrieb:

- `auto` (Default): nutzt `named`, wenn `BOT_CLOUDFLARE_TUNNEL_NAME` gesetzt ist, sonst `quick` bei leerer/trycloudflare `BOT_WEBAPP_URL`
- `named`: startet `cloudflared tunnel run <name>` (empfohlen fuer stabilen Betrieb)
- `quick`: startet einen rotierenden `trycloudflare` Quick Tunnel
- `off`: kein durch den Bot gemanagter Tunnel

Empfohlene Named-Tunnel-Konfiguration:

- `BOT_CLOUDFLARE_TUNNEL_MODE=named`
- `BOT_CLOUDFLARE_TUNNEL_NAME=termbot`
- `BOT_WEBAPP_URL=https://bot.example.com`
- optional: `BOT_CLOUDFLARE_CONFIG_PATH=/Users/<user>/.cloudflared/config.yml`
- optional statt `BOT_WEBAPP_URL`: `BOT_CLOUDFLARE_TUNNEL_HOSTNAME=bot.example.com`

Minimaler Setup fuer Named Tunnel (einmalig):

```bash
cloudflared tunnel login
cloudflared tunnel create termbot
cloudflared tunnel route dns termbot bot.example.com
```

Optional fuer Slack:

- `SLACK_BOT_ENABLED=1`
- `SLACK_BOT_TOKEN=xoxb-...`
- `SLACK_APP_TOKEN=xapp-...` (Socket Mode)
- optional: `SLACK_ALLOWED_USER_ID=U...`
- optional: `SLACK_ALLOWED_CHANNEL_ID=C...`
- optional: `SLACK_STARTUP_CHANNEL_ID=C...`

## Architektur

- `bot.js`: Telegram/Slack Controller, Session-Orchestrierung, Reminder, Profile, Mini-App API
- `scripts/codexbot-daemon.js`: lokaler Daemon fuer langlebige Codex-Runs
- `scripts/codexbot-cli.js`: lokale CLI (`start|stop|status|ask|new|cancel|repl|logs`)
- `scripts/restart-bot-helper.js`: robuster Self-Restart ohne Prozess-Race
- `scripts/termbot-supervisor.js`: Supervisor-First Runtime (Single Source of Truth)
- `scripts/bot-doctor.js`: Runtime-Diagnose (`npm run bot:doctor`)
- `scripts/bot-restart-test.js`: lokaler Restart-Smoke (`npm run bot:restart-test`)
- `public/telegram-miniapp/*`: WebApp Command Center
- `data/`: lokale Laufzeitdaten (state, logs, reminders, profile)
- `data/runtime/events.jsonl`: strukturierte Runtime-Events (`command_*`, `restart_*`, `runtime_*`)

## Container Deploy (Server)

Voraussetzung: Docker + Docker Compose Plugin auf dem Server.

```bash
git clone <dein-repo-url>
cd TermBot
cp .env.example .env
# .env mit echten Werten fuellen (mindestens TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USER_ID)
docker compose up -d --build
```

Logs/Status:

```bash
docker compose logs -f termbot
docker compose ps
```

Ausfuehrliche Schritt-fuer-Schritt-Anleitung:

- `docs/CONTAINER_DEPLOY.md`

Container bringt mit:

- `node 22`
- `tmux` (fuer Codex-Session-Backend)
- `@openai/codex` CLI
- `cloudflared` (Quick oder Named Tunnel)
- Healthcheck auf `http://127.0.0.1:8787/telegram-miniapp/index.html`

Wichtig fuer Codex im Container:

- `CODEX_HOME` ist auf Volume `codex_home` gelegt (persistente Auth/Profile)
- Falls noetig im Container einmalig einloggen: `docker compose exec termbot codex login`

## Sicherheit

- Zugriff nur fuer `TELEGRAM_ALLOWED_USER_ID`
- Mini-App Requests werden per Telegram `initData` validiert
- Rate Limits fuer Live/Input API
- Secrets nur in `.env`, nie committen
- Laufzeitdaten bleiben lokal in `data/`

## Trademark & Affiliation

- TermBot ist ein Community-Projekt.
- `Codex`, `OpenAI` und `Telegram` sind Marken ihrer jeweiligen Inhaber.
- Die Nennung dient nur der Kompatibilitaetsbeschreibung.

## Betrieb

### One-click Start (macOS)

```bash
./START_BOT.command
```

### PM2 (optional)

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

## Tests

```bash
npm test
npm run test:miniapp
npm run bot:doctor
# optional auto-cleanup of stale runtime state / duplicate processes:
npm run bot:doctor -- --fix
# optional (erfordert laufenden Supervisor):
npm run bot:restart-test
```

## Lizenz

Aktuell keine `LICENSE` im Repo enthalten.
