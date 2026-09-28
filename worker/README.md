# benchmark runner (Cloudflare Worker)

Runs the full model benchmark on Cloudflare — no GitHub Actions needed.
Every 30 min (cron) the worker fetches OpenCode Zen + models.dev + the HF
leaderboard, rebuilds all comparison SVGs with the shared logic in
`scripts/benchmark-core.mjs`, and commits `data/*.svg`, `README.md` and
`data/state.json` straight back to `main` via the GitHub git-database API.
Commits only happen when the tree actually changed (model added/removed or
fresh dates); otherwise KV state is just refreshed.

Brand badges inline the mono files from `@lobehub/icons-static-svg`
(see https://lobehub.com/icons/skill.md), committed as generated code in
`src/lobe-icons.js` — regenerate after bumping the package:

```bash
node scripts/gen-lobe-icons.mjs
```

## Setup

```bash
cd worker
npx wrangler kv:namespace create BENCH_STATE
# paste the id into wrangler.toml [[kv_namespaces]], then:
npx wrangler secret put GITHUB_TOKEN    # repo contents:write token
npx wrangler secret put TRIGGER_SECRET  # random string for manual POST /trigger
npx wrangler deploy
```

`GITHUB_REPO` is already set under `[vars]` in `wrangler.toml`.

## Endpoints

- `GET /` → runner status + last-check state from KV.
- `POST /trigger[?force=1]` + `Authorization: Bearer <TRIGGER_SECRET>` →
  run the pipeline now (`force=1` regenerates + commits even with no model
  change; otherwise identical trees are skipped).
