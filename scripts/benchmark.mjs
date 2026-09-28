#!/usr/bin/env node
/**
 * Model benchmark — OpenCode Zen free models vs HF OpenEvals leaderboard.
 *
 * Sources (all public, no key required):
 *  - OpenCode Zen list (truth for availability): https://opencode.ai/zen/v1/models
 *  - models.dev `opencode` provider (name, context, price, description): https://models.dev/api.json
 *  - HF OpenEvals leaderboard (benchmark scores): https://huggingface.co/datasets/OpenEvals/leaderboard-data/resolve/main/leaderboard.json
 *
 * Behavior (sesuai tujuan):
 *  - state di data/state.json mencatat free-model terakhir terlihat.
 *  - added   = id free baru muncul di Zen  -> generate SVG vs baseline.
 *  - removed = id free hilang dari Zen (paid/retired) -> hapus SVG + hapus section README.
 *  - --all   = (re)generate semua pasangan vs baseline (default saat state kosong).
 *
 * Output:
 *  - data/<a>-vs-<b>.svg
 *  - README.md section di antara <!-- BENCHMARK:START --> ... <!-- BENCHMARK:END -->
 *
 * Run:
 *  node scripts/benchmark.mjs [--all] [--dry-run] [--out=data] [--state=data/state.json] [--readme=README.md]
 *
 * Pure logic lives in ./benchmark-core.mjs (shared with the Cloudflare Worker).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchZenIds,
  fetchModelsDev,
  fetchLeaderboard,
  buildRecords,
  pickBaseline,
  diffIds,
  buildLivePairs,
  buildRows,
  renderVsSVG,
  slug,
  buildReadmeSection,
  spliceReadmeSection,
} from "./benchmark-core.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(=(.*))?$/);
    return m ? [m[1], m[3] ?? true] : ["_", a];
  })
);
const OUT_DIR = resolve(String(args.out ?? "data"));
const STATE_PATH = resolve(String(args.state ?? join(OUT_DIR, "state.json")));
const README_PATH = resolve(String(args.readme ?? "README.md"));
const DO_ALL = Boolean(args.all);
const DRY_RUN = Boolean(args["dry-run"]);

// ---------------------------------------------------------------- lobe icons (node: read from installed package)
const __HERE = dirname(fileURLToPath(import.meta.url));
const LOBE_DIRS = [
  resolve(__HERE, "../node_modules/@lobehub/icons-static-svg/icons"),
  resolve(process.cwd(), "node_modules/@lobehub/icons-static-svg/icons"),
];

function loadLobeInner(slug) {
  for (const dir of LOBE_DIRS) {
    try {
      const p = join(dir, `${slug}.svg`);
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf8");
      const m = raw.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i);
      if (!m) continue;
      return m[1]
        .replace(/<title>[\s\S]*?<\/title>/gi, "")
        .replaceAll("currentColor", "#fff")
        .trim();
    } catch {
      // try next dir / fall back to custom art
    }
  }
  return null;
}

const LOBE_BADGE = new Map(); // slug -> inner markup (cached)
function lobeArt(slug) {
  if (!LOBE_BADGE.has(slug)) LOBE_BADGE.set(slug, loadLobeInner(slug));
  return LOBE_BADGE.get(slug);
}

// ---------------------------------------------------------------- state + readme
function loadState() {
  try {
    if (!existsSync(STATE_PATH)) return { updatedAt: null, models: {} };
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { updatedAt: null, models: {} };
  }
}

function updateReadme(pairs) {
  const today = new Date().toISOString().slice(0, 10);
  const section = buildReadmeSection(pairs, { dateStr: today, cacheBuster: Date.now().toString(36) });
  let md = "";
  try {
    md = readFileSync(README_PATH, "utf8");
  } catch {
    md = "# Benchmarks\n";
  }
  md = spliceReadmeSection(md, section);
  if (!DRY_RUN) writeFileSync(README_PATH, md);
  return section;
}

// ---------------------------------------------------------------- main
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[info] fetching Zen + models.dev + leaderboard...`);
  const zenHeaders = {};
  if (process.env.OPENCODE_API_KEY) zenHeaders.Authorization = `Bearer ${process.env.OPENCODE_API_KEY}`;
  const hfHeaders = {};
  if (process.env.HF_TOKEN) hfHeaders.Authorization = `Bearer ${process.env.HF_TOKEN}`;
  const [zenIds, devModels, lb] = await Promise.all([
    fetchZenIds(zenHeaders),
    fetchModelsDev(),
    fetchLeaderboard(hfHeaders),
  ]);
  const records = buildRecords(zenIds, devModels, lb.models ?? []);
  console.log(`[info] zen=${zenIds.length} free=${records.size} leaderboard=${lb.models?.length ?? 0}`);

  const prev = loadState();
  const prevIds = new Set(Object.keys(prev.models ?? {}));
  const curIds = new Set(records.keys());
  const { added, removed } = diffIds([...prevIds], [...curIds]);
  const firstRun = prevIds.size === 0;

  console.log(`[info] added=${added.join(",") || "-"} removed=${removed.join(",") || "-"}`);

  // prune SVGs for removed (turned paid/retired)
  for (const id of removed) {
    const prefix = `${slug(id)}-vs-`;
    const suffix = `-vs-${slug(id)}.svg`;
    let files = [];
    try {
      files = readdirSync(OUT_DIR).filter((f) => f.endsWith(".svg") && (f.startsWith(prefix) || f.endsWith(suffix)));
    } catch {}
    for (const f of files) {
      console.log(`[prune] ${f} (${id} no longer free)`);
      if (!DRY_RUN) rmSync(join(OUT_DIR, f), { force: true });
    }
  }

  // decide what to (re)generate:
  // - first run or --all: every free model vs baseline
  // - else: only added + models whose baseline pairing file is missing
  let targets;
  if (firstRun || DO_ALL) {
    targets = [...records.values()];
  } else {
    targets = added.map((id) => records.get(id)).filter(Boolean);
    // repair missing files (e.g. baseline changed)
    for (const rec of records.values()) {
      const base = pickBaseline(rec.id, records);
      if (!base) continue;
      const fname = `${slug(rec.id)}-vs-${slug(base.id)}.svg`;
      if (!existsSync(join(OUT_DIR, fname)) && !targets.find((t) => t.id === rec.id)) {
        targets.push(rec);
      }
    }
  }

  const pairs = [];
  // full live pair list for README (one row per free model vs its baseline)
  const livePairs = buildLivePairs(records);

  for (const rec of targets) {
    const base = pickBaseline(rec.id, records);
    if (!base) {
      console.log(`[skip] ${rec.id}: no baseline (only free model)`);
      continue;
    }
    const rows = buildRows(rec, base);
    const svg = renderVsSVG(rec, base, rows, lobeArt);
    const fname = `${slug(rec.id)}-vs-${slug(base.id)}.svg`;
    console.log(`[write] ${fname}: ${rec.name} vs ${base.name}`);
    if (!DRY_RUN) writeFileSync(join(OUT_DIR, fname), svg);
    pairs.push({ a: rec, b: base, file: fname });
  }

  // README reflects live state, but skip rewrite when nothing changed (avoid churn)
  const changed = added.length > 0 || removed.length > 0 || targets.length > 0;
  if (changed) {
    const relPairs = livePairs.map((p) => ({ ...p, file: p.file.replace(/^.*data\//, "data/") }));
    if (!DRY_RUN) updateReadme(relPairs);
    console.log(`[info] README ${DRY_RUN ? "(dry-run, not written)" : "updated"} with ${relPairs.length} comparisons`);
  } else {
    console.log(`[info] no changes, README kept as-is`);
  }

  if (!DRY_RUN) {
    if (!changed) {
      console.log(`[info] state unchanged, kept as-is`);
    } else {
      const state = {
        updatedAt: new Date().toISOString(),
        models: Object.fromEntries(
          [...records.entries()].map(([id, r]) => [
            id,
            { name: r.name, context: r.context, priceAvg: r.priceAvg, status: r.status },
          ])
        ),
      };
      writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
      console.log(`[info] state -> ${STATE_PATH}`);
    }
  } else {
    console.log(`[dry-run] no files written`);
  }

  // console table for debug (pengganti console.dir(result) lama)
  console.table(
    [...records.values()].map((r) => ({
      id: r.id,
      ctx: r.context,
      price: r.priceAvg,
      agg: r.hf?.aggregateScore ?? "N/A",
      hf: r.hf?.id ?? "-",
    }))
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
