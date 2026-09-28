# benchmark trigger (Cloudflare Worker)

Watches the OpenCode Zen free-model set and triggers the `benchmark` GitHub
Actions workflow only on change (model added / turned paid).

## Setup

```bash
cd worker
npx wrangler kv:namespace create BENCH_STATE
# paste the id into wrangler.toml [[kv_namespaces]], then:
npx wrangler secret put GITHUB_TOKEN    # token with Actions write on this repo
npx wrangler secret put TRIGGER_SECRET  # random string for manual POST /trigger
npx wrangler deploy
```

`GITHUB_REPO` is already set under `[vars]` in `wrangler.toml`.

## Endpoints

- `GET /` → last-check status from KV.
- `POST /trigger` + `Authorization: Bearer <TRIGGER_SECRET>` → manual check.
- Cron `*/30 * * * *` → automatic check; dispatches
  `workflow_dispatch` on `.github/workflows/benchmark.yml` when the
  free-model set changed. The workflow runs `node scripts/benchmark.mjs`
  (no `--all`, so no churn) and commits updated SVGs/README/state.
