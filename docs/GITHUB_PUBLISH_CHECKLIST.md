# GitHub Publish Checklist (TermBot)

1. `.env` is not part of the commit.
2. `data/` contains only `.gitkeep` (or intentionally safe demo data).
3. No tokens/passwords/secrets in tracked files.

Quick scan:

```bash
rg -n --hidden -g '!node_modules/**' -g '!data/**' -e 'TELEGRAM_BOT_TOKEN=|NOTION_API_TOKEN=|OPENAI_API_KEY|ghp_|xox[baprs]-|eyJ[a-zA-Z0-9_-]+\.'
```
