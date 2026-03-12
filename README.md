# TermBot V0.2 (Schenni)

TermBot ist ein lokaler Telegram-Bot, der dein Terminal und eine persistente Codex-Session auf deinem Rechner steuert.
Statt nur Kommandos abzuschicken, arbeitest du im Chat mit einem Assistant zusammen.

> Hinweis: Community-Projekt. Keine offizielle Verbindung zu OpenAI, Telegram oder Slack.

## Inhaltsverzeichnis

- [1. Was TermBot kann](#1-was-termbot-kann)
- [2. Architektur auf einen Blick](#2-architektur-auf-einen-blick)
- [3. Voraussetzungen](#3-voraussetzungen)
- [4. Quick Start (lokal)](#4-quick-start-lokal)
- [5. Konfiguration (.env)](#5-konfiguration-env)
- [6. Telegram-Kommandos](#6-telegram-kommandos)
- [7. Lokale CLI-Kommandos](#7-lokale-cli-kommandos)
- [8. Mini-App und Tunnel](#8-mini-app-und-tunnel)
- [9. Persoenlichkeit und Memory](#9-persoenlichkeit-und-memory)
- [10. Voice-Transkription](#10-voice-transkription)
- [11. Notion Sync (optional)](#11-notion-sync-optional)
- [12. Betrieb](#12-betrieb)
- [13. Tests und Diagnose](#13-tests-und-diagnose)
- [14. Troubleshooting](#14-troubleshooting)
- [15. Sicherheit](#15-sicherheit)
- [16. Projektstruktur](#16-projektstruktur)
- [17. GitHub Release-Flow](#17-github-release-flow)
- [18. Lizenz und Marken](#18-lizenz-und-marken)

## 1. Was TermBot kann

- Telegram steuert lokale Shell-Kommandos und Codex-Sessions.
- Persistente Codex-Session via `tmux` mit Chat-Weiterfuehrung.
- Smart-Mix: normaler Chat als Assistant-Input, `/sh` fuer explizite Shell.
- Mini-App Command Center mit Live-Ausgabe, Events und Runtime-Status.
- Reminder/Produktivitaet: Timer, einmalige Reminder, taegliche Reminder, Terminal-Reminder.
- User-Profil + Persona-Overlay (`V3_PERSONALITY.md`) fuer konsistente Antworten.
- Optional: Slack Socket Mode Bridge.
- Optional: Notion Activity Sync (API oder MCP).
- Optional: Voice-Nachrichten -> Transkript -> normale Verarbeitung.

## 2. Architektur auf einen Blick

- [`bot.js`](./bot.js): Hauptprozess, Telegram/Slack-Handling, Runtime-Orchestrierung, Reminder, Mini-App API.
- [`scripts/termbot-supervisor.js`](./scripts/termbot-supervisor.js): Supervisor-Startpunkt (`npm run start`).
- [`scripts/codexbot-daemon.js`](./scripts/codexbot-daemon.js): langlebiger Daemon fuer Codex-Runs.
- [`scripts/codexbot-cli.js`](./scripts/codexbot-cli.js): lokale Steuerung (`bot start|stop|status|ask|...`).
- [`public/telegram-miniapp/`](./public/telegram-miniapp): Mini-App UI.
- [`data/`](./data): lokale Runtime-Dateien (Events, State, Profile, Reminder).

## 3. Voraussetzungen

- Node.js 22+ (empfohlen)
- `npm`
- `tmux`
- Telegram-Bot-Token von BotFather
- Eigene Telegram User ID fuer Allowlist
- Optional fuer Tunnel: `cloudflared`
- Optional fuer Voice: `python3` + OpenAI API Key (je nach Setup)

## 4. Quick Start (lokal)

```bash
npm install
cp .env.example .env
```

`.env` minimal setzen:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID`
- `BOT_CWD` (absoluter Pfad zu diesem Repo)
- `CODEX_HOME` (absoluter Pfad zu deinem `.codex`)
- `CODEX_CWD` (absoluter Pfad zu diesem Repo)

Starten:

```bash
npm run start
```

## 5. Konfiguration (.env)

Wichtige Schalter fuer den stabilen Default-Betrieb:

- `BOT_CODEX_BACKEND=tmux`
- `BOT_AUTO_START_CODEX=1`
- `BOT_PROMPT_ON_START=1`
- `BOT_SINGLE_INSTANCE=1`
- `BOT_ENABLE_RESTART_COMMAND=1`
- `BOT_RESTART_HEALTH_TIMEOUT_MS=15000`
- `BOT_RESTART_READY_FILE=data/runtime/restart-ready.json`
- `BOT_CHAT_TYPING_ACTION=1`
- `BOT_CHAT_SEND_THINKING_MARKER=1`

Profil/Persona:

- `BOT_PERSONALITY_AUTO_APPLY=1`
- `BOT_PERSONALITY_FILE=V3_PERSONALITY.md`
- `BOT_PERSONALITY_MAX_CHARS=12000`
- `BOT_PREFERENCE_LEARNING=1`
- `BOT_PREFERENCE_LEARNING_MAX_HINTS=20`

Mini-App:

- `BOT_WEBAPP_ENABLE=1`
- `BOT_WEB_PORT=8787`
- `BOT_WEB_HOST=127.0.0.1`
- `BOT_WEBAPP_URL=https://...` (feste URL empfohlen)

## 6. Telegram-Kommandos

Core:

- `/start` Hilfe/Quickstart
- `/setupassistant` Assistenten-Profil einrichten
- `/codexstart` Codex-Session starten
- `/ask <text>` Prompt direkt an Codex
- `/status` Runtime-Status anzeigen
- `/stopcodex` Session stoppen
- `/cancel` laufenden Vorgang abbrechen
- `/pwd` aktuelles Arbeitsverzeichnis

Shell und Kontext:

- `/sh <command>` Shell-Befehl (nur wenn keine aktive Codex-Session laeuft)
- `/projects` letzte Projektkontexte anzeigen
- `/panel` Mini-App-Link senden
- `/panelstatus` Mini-App/Tunnel/API-Status

Produktivitaet:

- `/timer <dauer> <text>` z. B. `/timer 25m Fokus`
- `/remind <hh:mm> <text>` einmalig
- `/daily <hh:mm> <text>` taeglich
- `/terminal <hh:mm>` taeglicher Terminal-Check
- `/reminders` aktive Reminder
- `/remindoff <id>` Reminder deaktivieren

## 7. Lokale CLI-Kommandos

```bash
npm run bot:start
npm run bot:status
npm run bot:ask -- "Sag nur OK"
npm run bot:new
npm run bot:cancel
npm run bot:logs
npm run bot:stop
```

Direktstart ohne Supervisor:

```bash
npm run bot:direct
```

## 8. Mini-App und Tunnel

Die Mini-App ist unter `http://127.0.0.1:8787/telegram-miniapp/index.html` erreichbar (lokal).

Cloudflare Tunnel Modus:

- `BOT_CLOUDFLARE_TUNNEL_MODE=auto` (Default)
- `named` fuer stabile eigene Domain
- `quick` fuer temporaere TryCloudflare-URL
- `off` deaktiviert Bot-gemanagten Tunnel

Empfohlen fuer Produktion:

- `BOT_CLOUDFLARE_TUNNEL_MODE=named`
- `BOT_CLOUDFLARE_TUNNEL_NAME=termbot`
- `BOT_WEBAPP_URL=https://bot.example.com`

Einmaliges Named-Tunnel-Setup:

```bash
cloudflared tunnel login
cloudflared tunnel create termbot
cloudflared tunnel route dns termbot bot.example.com
```

## 9. Persoenlichkeit und Memory

- `/setupassistant` schreibt User-Profile nach `data/user-profile.json`.
- Profilblock wird in `V3_PERSONALITY.md` synchronisiert.
- Bei neuen Codex-Sessions wird dieses Profil automatisch injiziert.
- Lern-Hinweise aus Chats werden optional ueber `BOT_PREFERENCE_LEARNING` gespeichert.

## 10. Voice-Transkription

- Aktivierung: `BOT_VOICE_ENABLED=1`
- Max-Laenge: `BOT_VOICE_MAX_DURATION_SEC=240`
- Standardskript: `$CODEX_HOME/skills/transcribe/scripts/transcribe_diarize.py`
- Modell: `BOT_VOICE_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe`

Ablauf:

1. Voice/Audio empfangen
2. Transkribieren
3. Text wie normale Chat-Nachricht weiterverarbeiten

## 11. Notion Sync (optional)

- Aktivieren: `NOTION_SYNC_ENABLED=1`
- Modus: `NOTION_SYNC_MODE=auto` (API wenn Token vorhanden, sonst MCP)
- Modus: `NOTION_SYNC_MODE=api`
- Modus: `NOTION_SYNC_MODE=mcp`

Fuer API-Modus setzen:

- `NOTION_API_TOKEN`
- `NOTION_DATABASE_ID`

## 12. Betrieb

One-click (macOS):

```bash
./START_BOT.command
```

PM2 (optional):

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Docker/Server:

- Siehe [`docs/CONTAINER_DEPLOY.md`](./docs/CONTAINER_DEPLOY.md)

Kurzstart:

```bash
docker compose up -d --build
docker compose logs -f termbot
docker compose ps
```

## 13. Tests und Diagnose

```bash
npm test
npm run test:miniapp
npm run test:runtime
npm run bot:doctor
npm run bot:doctor -- --fix
```

Restart-Smoke (benoetigt laufenden Supervisor):

```bash
npm run bot:restart-test
```

## 14. Troubleshooting

`A session is already running`:

1. `/status` pruefen
2. `/stopcodex` ausfuehren
3. neu mit `/codexstart` starten

Mini-App nicht erreichbar:

1. `BOT_WEBAPP_ENABLE=1` pruefen
2. `BOT_WEB_PORT` und `BOT_WEB_HOST` pruefen
3. `/panelstatus` aufrufen
4. `npm run bot:logs` ansehen

Codex startet nicht:

1. `codex login status` lokal pruefen
2. Auf Headless-Systemen oder im Container `codex login --device-auth` nutzen
3. Im Container: `docker compose exec termbot codex login --device-auth`
4. Danach `docker compose exec termbot codex login status` pruefen
5. `CODEX_HOME` und `CODEX_CWD` pruefen
6. `tmux` Verfuegbarkeit pruefen
7. `npm run bot:doctor` ausfuehren

Warum `--device-auth`:

- Der normale Browser-Login arbeitet mit einem `localhost`-Redirect.
- Auf Servern, per SSH oder im Container landet der Redirect oft am falschen Ort oder ist gar nicht erreichbar.
- `--device-auth` zeigt stattdessen Code plus URL, die du auf deinem normalen Browser oeffnest.

## 15. Sicherheit

- Zugriff auf Telegram-Seite per `TELEGRAM_ALLOWED_USER_ID` eingeschraenkt.
- Mini-App Requests werden ueber Telegram `initData` validiert.
- API Endpunkte sind standardmaessig lokal (`BOT_WEB_HOST=127.0.0.1`).
- Rate-Limits fuer Live- und Input-Endpunkte aktiv.
- Secrets nie committen, nur in `.env`.
- Laufzeitdaten liegen lokal in `data/`.

## 16. Projektstruktur

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

## 17. GitHub Release-Flow

Empfohlener Ablauf:

1. Tests/Checks laufen lassen (`npm test`, `npm run bot:doctor`).
2. Secret-Scan ausfuehren (siehe [`docs/GITHUB_PUBLISH_CHECKLIST.md`](./docs/GITHUB_PUBLISH_CHECKLIST.md)).
3. Commit erstellen.
4. Branch pushen und PR erstellen.

## 18. Lizenz und Marken

- Aktuell ist keine `LICENSE`-Datei im Repo hinterlegt.
- `OpenAI`, `Codex`, `Telegram`, `Slack` sind Marken ihrer jeweiligen Inhaber.
- Nennung dient nur zur Kompatibilitaetsbeschreibung.
