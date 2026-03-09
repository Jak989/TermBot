# Release Plan: v1.0.1-restart-hotfix

## Branching

1. Create branch: `codex/restart-rebuild`
2. Open PR into `main`
3. Merge after tests + smoke checks pass

## Required Checks

```bash
npm test
npm run bot:doctor
# optional, requires active supervisor runtime:
npm run bot:restart-test
```

## Tagging

After merge:

```bash
git tag v1.0.1-restart-hotfix
git push origin v1.0.1-restart-hotfix
```

## Rollback

Primary rollback target: `v1.0.0` (or last known-good SHA before this hotfix).

```bash
git checkout main
git reset --hard v1.0.0
# or deploy previous stable SHA from CI/CD artifact
```

For runtime rollback without code changes:

1. Stop supervisor
2. Restore previous `.env` values if changed
3. Start previous release artifact
