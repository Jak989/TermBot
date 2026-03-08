# TermBot Container Deploy (Server)

## 1) Voraussetzungen

- Docker Engine + Docker Compose Plugin
- Offener TCP-Port `8787` (falls Mini-App extern erreichbar sein soll)

## 2) Projekt holen

```bash
git clone <REPO_URL>
cd TermBot
cp .env.example .env
```

## 3) `.env` setzen (Pflicht)

Mindestens:

- `TELEGRAM_BOT_TOKEN=...`
- `TELEGRAM_ALLOWED_USER_ID=...`

Empfohlen:

- `BOT_CODEX_BACKEND=tmux`
- `BOT_ENABLE_RESTART_COMMAND=1`
- `BOT_AUTO_START_CODEX=1`

Optional:

- `OPENAI_API_KEY=...` (falls Codex ohne interaktiven Login laufen soll)
- `BOT_WEBAPP_URL=https://...` (eigene Domain/Reverse Proxy)

## 4) Container starten

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f termbot
```

## 5) Codex im Container aktivieren

Wenn du kein `OPENAI_API_KEY` in `.env` nutzt:

```bash
docker compose exec termbot codex login
```

Die Codex-Konfiguration bleibt persistent im Docker-Volume `codex_home`.

## 6) Health / Troubleshooting

Mini-App lokal im Container:

```bash
docker compose exec termbot curl -fsS http://127.0.0.1:8787/telegram-miniapp/index.html | head
```

Restart testen:

- Telegram: `/restartbot`
- Erwartung: Bot startet neu und startet Codex automatisch
