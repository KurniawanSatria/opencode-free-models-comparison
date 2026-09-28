import {
  fetchZenIds,
  fetchModelsDev,
  fetchLeaderboard,
  buildRecords,
  buildLivePairs,
  buildRows,
  renderVsSVG,
  buildReadmeSection,
  spliceReadmeSection,
  diffIds,
} from "../../scripts/benchmark-core.mjs";
import { LOBE_INNERS } from "./lobe-icons.js";

const KV_KEY = "zen:free:v1";
const resolveLobe = (slug) => LOBE_INNERS[slug] ?? null;

const te = new TextEncoder();
const td = new TextDecoder();
function b64encode(str) {
  const b = te.encode(str);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64decode(b64) {
  const s = atob(b64.replace(/\n/g, ""));
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return td.decode(b);
}

async function gh(path, env, opts = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    method: opts.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "opencode-benchmark-trigger",
    },
    body: opts.body,
  });
  if (!r.ok) throw new Error(`github ${opts.method || "GET"} ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  if (r.status === 204) return null;
  return r.json();
}

function ghHeaders(env) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "opencode-benchmark-trigger",
  };
}

async function runPipeline(env, { force = false } = {}) {
  if (!env.GITHUB_TOKEN) throw new Error("missing GITHUB_TOKEN secret");
  if (!env.GITHUB_REPO) throw new Error("missing GITHUB_REPO var");
  const [owner, repo] = String(env.GITHUB_REPO).split("/");
  const R = `/repos/${owner}/${repo}`;

  const [zenIds, devModels, lb] = await Promise.all([fetchZenIds(), fetchModelsDev(), fetchLeaderboard()]);
  const records = buildRecords(zenIds, devModels, lb.models ?? []);
  const curIds = [...records.keys()].sort();

  const prevState = (await env.BENCH_STATE.get(KV_KEY, "json")) ?? { ids: [] };
  const prevIds = Array.isArray(prevState.ids) ? prevState.ids : [];
  const { added, removed } = diffIds(prevIds, curIds);
  const changed = added.length > 0 || removed.length > 0;
  const checkedAt = new Date().toISOString();

  if (!changed && !force) {
    await env.BENCH_STATE.put(KV_KEY, JSON.stringify({ ...prevState, ids: curIds, checkedAt }));
    return { checkedAt, count: curIds.length, added, removed, changed: false, committed: false };
  }

  const dateStr = checkedAt.slice(0, 10);
  const cacheBuster = Date.now().toString(36);
  const pairs = buildLivePairs(records);

  const files = {};
  for (const p of pairs) {
    files[p.file] = renderVsSVG(p.a, p.b, buildRows(p.a, p.b), resolveLobe, dateStr);
  }
  files["data/state.json"] = JSON.stringify(
    {
      updatedAt: checkedAt,
      models: Object.fromEntries(
        [...records.entries()].map(([id, r]) => [id, { name: r.name, context: r.context, priceAvg: r.priceAvg, status: r.status }])
      ),
    },
    null,
    2
  );

  const ref = await gh(`${R}/git/ref/heads/main`, env);
  const headSha = ref.object.sha;
  const headCommit = await gh(`${R}/git/commits/${headSha}`, env);
  const baseTreeSha = headCommit.tree.sha;
  const readmeRes = await fetch(`https://api.github.com${R}/contents/README.md?ref=main`, { headers: ghHeaders(env) });
  if (!readmeRes.ok) throw new Error(`github GET contents/README.md: ${readmeRes.status}`);
  const readmeJson = await readmeRes.json();
  const section = buildReadmeSection(pairs, { dateStr, cacheBuster });
  files["README.md"] = spliceReadmeSection(b64decode(readmeJson.content), section);

  const treeEntries = [];
  if (removed.length > 0) {
    const fullTree = await gh(`${R}/git/trees/${baseTreeSha}?recursive=1`, env);
    const gone = new Set(removed);
    for (const e of fullTree.tree || []) {
      if (e.type !== "blob" || !e.path.startsWith("data/") || !e.path.endsWith(".svg")) continue;
      const base = e.path.slice(5, -4);
      const hit = [...gone].some((id) => {
        const s = String(id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        return base.startsWith(`${s}-vs-`) || base.endsWith(`-vs-${s}`);
      });
      if (hit) treeEntries.push({ path: e.path, mode: "100644", type: "blob", sha: null });
    }
  }

  for (const [path, content] of Object.entries(files)) {
    const blob = await gh(`${R}/git/blobs`, env, {
      method: "POST",
      body: JSON.stringify({ content: b64encode(content), encoding: "base64" }),
    });
    treeEntries.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const newTree = await gh(`${R}/git/trees`, env, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
  });
  const totalBytes = Object.values(files).reduce((n, s) => n + s.length, 0);
  if (newTree.sha === baseTreeSha) {
    await env.BENCH_STATE.put(KV_KEY, JSON.stringify({ ids: curIds, checkedAt, added, removed }));
    return { checkedAt, count: curIds.length, added, removed, changed, generated: pairs.length, bytes: totalBytes, committed: false };
  }
  const commit = await gh(`${R}/git/commits`, env, {
    method: "POST",
    body: JSON.stringify({
      message: `chore: refresh model benchmarks [cf worker]${added.length ? ` (+${added.join(",")})` : ""}${removed.length ? ` (-${removed.join(",")})` : ""}`,
      tree: newTree.sha,
      parents: [headSha],
    }),
  });
  await gh(`${R}/git/refs/heads/main`, env, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
  await env.BENCH_STATE.put(KV_KEY, JSON.stringify({ ids: curIds, checkedAt, added, removed }));
  return { checkedAt, count: curIds.length, added, removed, changed, generated: pairs.length, bytes: totalBytes, committed: true, commit: commit.sha };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runPipeline(env).catch((e) => console.error("cron pipeline failed:", e.message)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/trigger") {
      const auth = request.headers.get("Authorization") ?? "";
      if (!env.TRIGGER_SECRET || auth !== `Bearer ${env.TRIGGER_SECRET}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      try {
        return Response.json(await runPipeline(env, { force: url.searchParams.get("force") === "1" }));
      } catch (e) {
        return Response.json({ error: e.message }, { status: 502 });
      }
    }
    if (url.pathname === "/") {
      const state = (await env.BENCH_STATE.get(KV_KEY, "json")) ?? null;
      return Response.json({ ok: true, runner: "cloudflare-worker", state });
    }
    return new Response("not found", { status: 404 });
  },
};
