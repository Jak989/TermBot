# TermBot

**TermBot ist ein Telegram-gesteuertes Terminal Command Center.**

Es steuert deine lokale Shell remote, fuehrt normale Terminal-Aufgaben aus und hat einen spezialisierten Codex-Modus fuer laengere AI-Workflows direkt im Terminal.

## Warum TermBot besser ist

- Ein Bot fuer **alles im Terminal**, nicht nur fuer Chat-Kommandos.
- Spezieller **Codex-Betrieb mit persistenter Session** (tmux), damit lange Tasks nicht verloren gehen.
- **Mini-App Command Center** mit Live-Ansicht, Raw-Output, Events und Systemstatus.
- **Sicherheitsgrenzen eingebaut** (Telegram User-Allowlist, signierte Mini-App Requests, Rate Limits).
- **Produktiv im Alltag**: Reminder, Daily Jobs, Projektkontext-Restore, Voice-Input, optional Notion-Sync.

## Capabilities

### A) General Terminal Control

- Idle-Modus: normale Telegram-Nachricht -> Shell/Terminal-Input
- konfigurierbares Arbeitsverzeichnis (`BOT_CWD`) und Shell (`BOT_SHELL`)
- Runtime-Befehle: `/status`, `/pwd`, `/cancel`, `/stopcodex`
- Fokus-/Zeit-Workflows:
  - `/timer 25m Fokusblock`
  - `/remind 18:30 Nachricht`
  - `/daily 09:00 Nachricht`
  - `/terminal 09:00`
  - `/reminders`, `/remindoff <id>`

### B) Codex Specialist Mode

- `/codexstart` startet interaktive Codex-Session
- `/ask <text>` startet Codex bei Bedarf und sendet Prompt direkt
- persistente Session via tmux (`BOT_CODEX_BACKEND=tmux`)
- waehrend Codex laeuft:
  - Nachricht -> stdin Zeile
  - `/enter` -> Enter mit Fallback-Sequenz (CR -> LF -> CRLF)
  - `/raw <text>` -> Rohtext ohne Enter
  - `/stopcodex` / `/cancel` -> Session stoppen
- Turn-Monitoring mit `thinking ...` und `done` Semantik

### C) Mini-App Command Center

- Tabs: **Codex**, **Raw**, **Events**, **System**
- Live Snapshot + strukturierte Antwortdarstellung + Raw-Ausgabe
- direkte Eingaben (SEND/ESC), Start/Stop Codex, optional Restart-Bot
- Reply-Quick-Actions bei Rueckfragen (`yes`, `yes always`, `no but...`)
- Endpunkte:
  - `GET /api/miniapp/live`
  - `POST /api/miniapp/input`

### D) Voice + Knowledge Sync

- Voice Notes / Audio -> Transkription -> normale Bot-Verarbeitung
- konfigurierbare Transkriptionspipeline (`python3` + skill script)
- optional Notion Activity Sync (API oder MCP-Modus) mit Retry-Queue

## Architektur

- `bot.js` Telegram-Controller + Session-Orchestrierung + Mini-App API
- `scripts/codexbot-daemon.js` lokaler Daemon fuer langlebige Codex-Runs
- `scripts/codexbot-cli.js` CLI (`start|stop|status|ask|new|cancel|repl|logs`)
- `public/telegram-miniapp/*` Frontend fuer das Live-Panel
- `data/` lokale Laufzeitdaten (logs, state, reminders, profile, activity)

## Quick Start

```bash
npm install
cp .env.example .env
```

### Minimal benoetigt

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID`
- `BOT_CWD=/absoluter/pfad/zum/projekt`

### Empfohlen

- `BOT_CODEX_BACKEND=tmux`
- `BOT_WEBAPP_ENABLE=1`
- `BOT_WEBAPP_URL=https://...` (Telegram Mini-App URL)
- `BOT_AUTO_START_CODEX=1`
- `BOT_STARTUP_SEND_PANEL=1`

Start:

```bash
npm run bot
```

## Telegram Command Reference

- `/start` Hilfe + Startstatus
- `/setupassistant` Setup fuer Namen/Ton/Preferences
- `/codexstart` Codex starten
- `/ask <text>` Prompt direkt an Codex
- `/panel` Mini-App Button senden
- `/panelstatus` Mini-App Konfiguration anzeigen
- `/projects` letzte Projektkontexte anzeigen/wiederherstellen
- `/voice` Voice-Pipeline Status
- `/timer`, `/remind`, `/daily`, `/terminal`, `/reminders`, `/remindoff`
- `/status`, `/pwd`, `/stopcodex`, `/cancel`

## CLI / Daemon Usage

```bash
npm run bot:start
npm run bot:status
npm run bot:ask -- "Analysiere diesen Fehler und gib Fix-Schritte"
npm run bot:new
npm run bot:cancel
npm run bot:repl
npm run bot:logs
npm run bot:stop
```

## Security Model

- Bot akzeptiert nur den konfigurierten Telegram User (`TELEGRAM_ALLOWED_USER_ID`)
- Mini-App Requests werden mit Telegram `initData` validiert
- API-Rate-Limits fuer Live/Input Endpunkte
- lokale Daten bleiben in `data/`
- Secrets gehoeren nur in `.env` (nie committen)

## Betrieb & Autostart

### One-Click (macOS)

```bash
./START_BOT.command
```

Startet Tunnel, schreibt `BOT_WEBAPP_URL` in `.env` und startet den Bot.

### PM2 (optional)

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

## Troubleshooting

- `tmux unavailable`: `tmux` installieren oder Backend anpassen
- `Voice transcription not ready`: `/voice` pruefen, Script/API-Key konfigurieren
- Mini-App ohne Daten: `BOT_WEBAPP_URL`, `/panelstatus` und Tunnel-Log pruefen
- Codex startet nicht: `BOT_CODEX_BACKEND`, `CODEX_BIN`, Rechte/Path pruefen

## Tests

```bash
npm run test:miniapp
```

## Lizenz

Aktuell keine `LICENSE` im Repo enthalten.
