# GitHub Publish Checklist (TermBot)

1. `.env` ist nicht im Commit.
2. `data/` enthaelt nur `.gitkeep`.
3. Keine Tokens/Passwoerter in Dateien.

Quick Scan:

```bash
rg -n --hidden -g '!node_modules/**' -g '!data/**' -e 'TELEGRAM_BOT_TOKEN=|NOTION_API_TOKEN=|OPENAI_API_KEY|ghp_|xox[baprs]-|eyJ[a-zA-Z0-9_-]+\.'
```
