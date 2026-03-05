# TermBot

TermBot ist ein Telegram-Bot fuer dein lokales Terminal, der gleichzeitig als persoenlicher Assistant arbeitet.

Der entscheidende Unterschied: **Sobald Codex laeuft, unterhaeltst du dich im Chat mit deinem Assistant** und laesst ihn Aufgaben erledigen, statt nur rohe Shell-Kommandos zu schicken.

## Was TermBot besonders macht

- Terminal-Steuerung per Telegram fuer deinen lokalen Rechner
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
| Mini App | Tabs fuer Codex, Raw, Events, System + direkte Eingaben |
| Voice | Audio/Voice -> Transkript -> Verarbeitung wie Text |
| Notion Sync (optional) | Aktivitaeten als Notion-Eintraege (API oder MCP) |

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
npm run bot
```

Mindestens setzen in `.env`:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID`
- `BOT_CWD=/absoluter/pfad/zum/projekt`

Empfohlen fuer vollen Assistant-Betrieb:

- `BOT_CODEX_BACKEND=tmux`
- `BOT_AUTO_START_CODEX=1`
- `BOT_PROMPT_ON_START=1`
- `BOT_PERSONALITY_AUTO_APPLY=1`
- `BOT_WEBAPP_ENABLE=1`
- `BOT_WEBAPP_URL=https://...`

## Architektur

- `bot.js`: Telegram Controller, Session-Orchestrierung, Reminder, Profile, Mini-App API
- `scripts/codexbot-daemon.js`: lokaler Daemon fuer langlebige Codex-Runs
- `scripts/codexbot-cli.js`: lokale CLI (`start|stop|status|ask|new|cancel|repl|logs`)
- `public/telegram-miniapp/*`: WebApp Command Center
- `data/`: lokale Laufzeitdaten (state, logs, reminders, profile)

## Sicherheit

- Zugriff nur fuer `TELEGRAM_ALLOWED_USER_ID`
- Mini-App Requests werden per Telegram `initData` validiert
- Rate Limits fuer Live/Input API
- Secrets nur in `.env`, nie committen
- Laufzeitdaten bleiben lokal in `data/`

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
npm run test:miniapp
```

## Lizenz

Aktuell keine `LICENSE` im Repo enthalten.
