# TermBot

TermBot ist ein Telegram-Bot, der deine **lokale Terminal-Umgebung** fernbedient.
Er kann allgemeine Shell-Kommandos ausfuehren und hat zusaetzlich spezialisierte Funktionen fuer die Bedienung von `codex` im Terminal.

## Was TermBot kann

### 1) Allgemeiner Terminal-Bot (nicht nur Codex)

- normale Telegram-Nachrichten im Idle-Modus werden als Shell-Input verarbeitet
- arbeitet in einem festen Arbeitsverzeichnis (`BOT_CWD`)
- Status/Verzeichnis-Abfragen per `/status` und `/pwd`
- unterstuetzt Reminder/Timer-Workflows (`/timer`, `/remind`, `/daily`, `/reminders`)
- kann optional Audio/Voice in Text transkribieren und als Input verarbeiten

### 2) Codex-Spezialfunktionen

- startet eine interaktive Codex-Session (`/codexstart` oder `/ask <text>`)
- persistente Session mit `tmux`-Backend fuer laengere Aufgaben
- waehrend Codex laeuft:
  - normale Nachricht -> stdin Zeile
  - `/enter` -> Submit mit Fallback (CR -> LF -> CRLF)
  - `/raw <text>` -> Rohtext ohne Enter
  - `/stopcodex` oder `/cancel` -> Session stoppen
- Mini-App Live-Panel fuer strukturierte Ausgabe + Raw-Ansicht

## Kern-Features

- Telegram-Steuerung fuer lokale Terminal-Sessions
- persistente Codex-Ausfuehrung (tmux)
- Telegram Mini-App mit Live-Snapshot + Input API
- optionaler Notion-Sync fuer Aktivitaeten
- lokaler Daemon + CLI (`codexbot-daemon` / `codexbot-cli`)

## Projektstruktur

- `bot.js` Hauptprozess (Telegram + Mini-App API + Session-Orchestrierung)
- `scripts/codexbot-daemon.js` lokaler Daemon fuer langlebige Runs
- `scripts/codexbot-cli.js` lokale CLI fuer Start/Stop/Ask/Logs
- `public/telegram-miniapp/*` Mini-App Frontend
- `data/` lokale Laufzeitdaten (nicht committen)

## Setup

```bash
npm install
cp .env.example .env
```

Mindestens in `.env` setzen:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID`
- `BOT_CWD=/absoluter/pfad/zum/projekt`

Empfohlen:

- `BOT_CODEX_BACKEND=tmux`
- `BOT_WEBAPP_ENABLE=1`
- `BOT_WEBAPP_URL=https://...` (fuer Telegram Mini-App)

## Start

```bash
npm run bot
```

## Wichtige Telegram-Commands

- `/start` Hilfe/Status
- `/codexstart` Codex starten
- `/ask <text>` Prompt direkt an Codex
- `/panel` Mini-App Button senden
- `/panelstatus` Mini-App-Status anzeigen
- `/projects` letzte Projektkontexte
- `/status` Laufstatus
- `/pwd` aktuelles Arbeitsverzeichnis
- `/stopcodex` oder `/cancel` aktive Codex-Session beenden
- `/timer 25m Fokus`
- `/remind 18:30 Nachricht`
- `/daily 09:00 Nachricht`
- `/reminders`

## Mini-App API

Bei aktivierter Mini-App:

- `GET /api/miniapp/live`
- `POST /api/miniapp/input`

Fuer Telegram WebApp-Nutzung ist eine `https://` URL erforderlich (`BOT_WEBAPP_URL`).

## Sicherheit

- `.env` nie committen
- `data/` nur lokal halten
- keine Tokens/Passwoerter im Repo
- Bot-Zugriff auf Telegram auf eine User-ID begrenzen (`TELEGRAM_ALLOWED_USER_ID`)

## Test

```bash
npm run test:miniapp
```
