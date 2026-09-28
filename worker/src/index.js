/**
 * opencode-benchmark-trigger — Cloudflare Worker
 *
 * Polls the public OpenCode Zen model list, watches the free-model set
 * (`*-free` + `big-pickle`), and triggers the GitHub Actions `benchmark`
 * workflow only when models are added or removed (turned paid/retired).
 *
 * - Cron: every 30 min (see wrangler.toml [triggers]).
 * - State: KV `BENCH_STATE`, key `zen:free:v1` (sorted id array + checkedAt).
 * - Trigger: GitHub `workflow_dispatch` on `.github/workflows/benchmark.yml`
 *   (needs a repo-scoped token in `GITHUB_TOKEN` secret; no Actions write
 *   needed beyond dispatch).
 * - Manual: `POST /trigger` with `Authorization: Bearer <TRIGGER_SECRET>`,
 *   `GET /` returns last-check status as JSON.
 *
 * Setup:
 *   wrangler kv:namespace create BENCH_STATE
 *   wrangler secret put GITHUB_TOKEN     # ghp_/github_pat_ with Actions:read+write (or repo)
 *   wrangler secret put TRIGGER_SECRET  # any random string for manual POST /trigger
 *   wrangler deploy
 */

const ZEN_API = "https://opencode.ai/zen/v1/models";
const KV_KEY = "zen:free:v1";
const WORKFLOW = "benchmark.yml";

const isFreeId = (id) => id === "big-pickle" || String(id).endsWith("-free");

async function fetchFreeIds() {
  const r = await fetch(ZEN_API, { cf: { cacheTtl: 60 } });
  if (!r.ok) throw new Error(`zen ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const data = Array.isArray(j) ? j : j.data;
  if (!Array.isArray(data)) throw new Error("unexpected zen shape");
  return data.map((m) => m.id).filter(isFreeId).sort();
}

function diff(prev, cur) {
  const p = new Set(prev);
  const c = new Set(cur);
  return {
    added: cur.filter((id) => !p.has(id)),
    removed: prev.filter((id) => !c.has(id)),
  };
}

async function dispatchWorkflow(env) {
  // workflow_dispatch on the benchmark workflow (ref: default branch).
  const [owner, repo] = String(env.GITHUB_REPO).split("/");
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${WORKFLOW}/dispatches`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "opencode-benchmark-trigger",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (r.status !== 204) throw new Error(`dispatch ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

async function check(env) {
  const cur = await fetchFreeIds();
  const prevState = (await env.BENCH_STATE.get(KV_KEY, "json")) ?? { ids: [] };
  const prev = Array.isArray(prevState.ids) ? prevState.ids : [];
  const { added, removed } = diff(prev, cur);
  const changed = added.length > 0 || removed.length > 0;
  if (changed && env.GITHUB_TOKEN && env.GITHUB_REPO) {
    await dispatchWorkflow(env);
  }
  await env.BENCH_STATE.put(KV_KEY, JSON.stringify({ ids: cur, checkedAt: new Date().toISOString(), added, removed }));
  return { checkedAt: new Date().toISOString(), count: cur.length, added, removed, dispatched: changed };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(check(env).catch((e) => console.error("cron check failed:", e.message)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/trigger") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.TRIGGER_SECRET || auth !== `Bearer ${env.TRIGGER_SECRET}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      try {
        return Response.json(await check(env));
      } catch (e) {
        return Response.json({ error: e.message }, { status: 502 });
      }
    }
    if (url.pathname === "/") {
      const state = (await env.BENCH_STATE.get(KV_KEY, "json")) ?? null;
      return Response.json({ ok: true, workflow: WORKFLOW, state });
    }
    return new Response("not found", { status: 404 });
  },
};
