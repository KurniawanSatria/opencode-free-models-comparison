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
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ZEN_API = "https://opencode.ai/zen/v1/models";
const MODELS_DEV_API = "https://models.dev/api.json";
const HF_LEADERBOARD_URL =
  "https://huggingface.co/datasets/OpenEvals/leaderboard-data/resolve/main/leaderboard.json";

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

// ---------------------------------------------------------------- fetch
async function getJSON(url, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}: ${(await r.text()).slice(0, 300)}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- normalize / match
// BUG FIX vs skrip debug awal: includes() dua arah tanpa batas panjang
// menyebabkan false-positive ("muse" match "amusement", id pendek match semua).
const normalize = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const stripFree = (id) =>
  String(id ?? "")
    .toLowerCase()
    .replace(/-contributor-free$/, "")
    .replace(/-free$/, "");

function findLeaderboardEntry(opencodeId, leaderboardModels) {
  const base = normalize(stripFree(opencodeId));
  if (!base || base.length < 4) return null;
  // 1. exact match on normalized id / name / base
  for (const m of leaderboardModels) {
    const nid = normalize(m.id);
    const nname = normalize(m.name);
    if (nid === base || nname === base) return m;
  }
  // 2. prefix-aware contains, guarded by min length to avoid false positives
  let best = null;
  for (const m of leaderboardModels) {
    const nid = normalize(m.id);
    const nname = normalize(m.name);
    if (nid.length < 6 && nname.length < 6) continue;
    if (nid.includes(base) || base.includes(nid) || nname.includes(base) || base.includes(nname)) {
      // prefer longest overlap (most specific)
      const score = Math.max(
        nid.includes(base) ? base.length : 0,
        nname.includes(base) ? base.length : 0
      );
      if (!best || score > best.score) best = { m, score };
    }
  }
  return best?.m ?? null;
}

// ---------------------------------------------------------------- sources
async function fetchZenIds() {
  // BUG FIX: Zen /v1/models publik, tanpa auth, dan hanya berisi {id,object,created,owned_by}.
  // Skrip debug mengira ada m.name / m.context_length -> selalu undefined.
  const headers = {};
  if (process.env.OPENCODE_API_KEY) headers.Authorization = `Bearer ${process.env.OPENCODE_API_KEY}`;
  const j = await getJSON(ZEN_API, headers);
  const data = Array.isArray(j) ? j : j.data;
  if (!Array.isArray(data)) throw new Error("unexpected Zen shape: " + JSON.stringify(j).slice(0, 300));
  return data.map((m) => m.id).filter(Boolean);
}

async function fetchModelsDev() {
  const j = await getJSON(MODELS_DEV_API);
  const oc = j?.opencode?.models;
  if (!oc || typeof oc !== "object") throw new Error("models.dev missing opencode.models");
  return oc;
}

async function fetchLeaderboard() {
  // BUG FIX: endpoint debug .../api/datasets/.../leaderboard tidak ada (404).
  // Yang benar: resolve/main/leaderboard.json dengan shape {metadata, benchmarks, models[]}.
  // Field bukan {model_id,value,rank,verified} melainkan {id,name,benchmarks,aggregateScore}.
  try {
    const headers = {};
    if (process.env.HF_TOKEN) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
    const j = await getJSON(HF_LEADERBOARD_URL, headers);
    if (!Array.isArray(j.models)) throw new Error("leaderboard.models missing");
    return j;
  } catch (e) {
    console.warn(`[warn] leaderboard unavailable, continue without scores: ${e.message}`);
    return { metadata: {}, benchmarks: {}, models: [] };
  }
}

// ---------------------------------------------------------------- records
const isFreeId = (id) => id === "big-pickle" || String(id).endsWith("-free");

function buildRecords(zenIds, devModels, lbModels) {
  const zenSet = new Set(zenIds);
  const out = new Map();
  for (const id of zenSet) {
    if (!isFreeId(id)) continue; // hanya track model free + big-pickle
    const dev = devModels[id] ?? null;
    const hf = findLeaderboardEntry(id, lbModels);
    const costIn = dev?.cost?.input ?? null;
    const costOut = dev?.cost?.output ?? null;
    const priceAvg =
      costIn != null && costOut != null ? (Number(costIn) + Number(costOut)) / 2 : null;
    out.set(id, {
      id,
      name: dev?.name ?? id,
      description: dev?.description ?? "",
      family: dev?.family ?? "",
      context: dev?.limit?.context ?? null,
      priceInput: costIn,
      priceOutput: costOut,
      priceAvg,
      status: dev?.status ?? "active",
      hf: hf
        ? {
            id: hf.id,
            name: hf.name,
            aggregateScore: hf.aggregateScore ?? null,
            benchmarks: hf.benchmarks ?? {},
          }
        : null,
    });
  }
  return out;
}

function pickBaseline(selfId, records) {
  const others = [...records.values()].filter((r) => r.id !== selfId);
  if (!others.length) return null;
  // prefer highest aggregateScore, fallback largest context, fallback name
  others.sort((a, b) => {
    const sa = a.hf?.aggregateScore ?? -1;
    const sb = b.hf?.aggregateScore ?? -1;
    if (sb !== sa) return sb - sa;
    const ca = a.context ?? -1;
    const cb = b.context ?? -1;
    if (cb !== ca) return cb - ca;
    return a.id.localeCompare(b.id);
  });
  return others[0];
}

// ---------------------------------------------------------------- SVG
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function fmtCtx(v) {
  if (v == null) return "N/A";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}K`;
  return String(v);
}
function fmtPrice(v) {
  if (v == null) return "N/A";
  return `$${Number(v).toFixed(2)}`;
}
function fmtScore(v, suffix = "") {
  if (v == null) return "N/A";
  const n = Number(v);
  const s = Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
  return s + suffix;
}

function buildRows(a, b) {
  const g = (m, key) => m.hf?.benchmarks?.[key]?.score ?? null;
  return [
    {
      label: "Intelligence Index",
      sub: "aggregate, higher is better",
      aValue: a.hf?.aggregateScore ?? null,
      bValue: b.hf?.aggregateScore ?? null,
      aDisplay: fmtScore(a.hf?.aggregateScore),
      bDisplay: fmtScore(b.hf?.aggregateScore),
      higherIsBetter: true,
    },
    {
      label: "SWE-bench Verified",
      sub: "coding, higher is better",
      aValue: g(a, "sweVerified") ?? g(a, "swePro"),
      bValue: g(b, "sweVerified") ?? g(b, "swePro"),
      aDisplay: fmtScore(g(a, "sweVerified") ?? g(a, "swePro"), (g(a, "sweVerified") ?? g(a, "swePro")) != null ? "%" : ""),
      bDisplay: fmtScore(g(b, "sweVerified") ?? g(b, "swePro"), (g(b, "sweVerified") ?? g(b, "swePro")) != null ? "%" : ""),
      higherIsBetter: true,
    },
    {
      label: "Terminal-Bench",
      sub: "coding, higher is better",
      aValue: g(a, "terminalBench"),
      bValue: g(b, "terminalBench"),
      aDisplay: fmtScore(g(a, "terminalBench"), g(a, "terminalBench") != null ? "%" : ""),
      bDisplay: fmtScore(g(b, "terminalBench"), g(b, "terminalBench") != null ? "%" : ""),
      higherIsBetter: true,
    },
    {
      label: "Price per 1M tokens",
      sub: "avg in+out, lower is better",
      aValue: a.priceAvg,
      bValue: b.priceAvg,
      aDisplay: fmtPrice(a.priceAvg),
      bDisplay: fmtPrice(b.priceAvg),
      higherIsBetter: false,
    },
    {
      label: "Context window",
      sub: "larger is better",
      aValue: a.context,
      bValue: b.context,
      aDisplay: a.context != null ? `${fmtCtx(a.context)}` : "N/A",
      bDisplay: b.context != null ? `${fmtCtx(b.context)}` : "N/A",
      higherIsBetter: true,
    },
  ];
}

function winnerOf(row) {
  const { aValue, bValue, higherIsBetter } = row;
  if (aValue == null && bValue == null) return "tie";
  if (aValue == null) return "b";
  if (bValue == null) return "a";
  if (aValue === bValue) return "tie";
  const aWins = higherIsBetter ? aValue > bValue : aValue < bValue;
  return aWins ? "a" : "b";
}

function barWidths(row, maxW = 210) {
  const { aValue, bValue, higherIsBetter } = row;
  if (aValue == null && bValue == null) return [0, 0];
  if (aValue == null) return [0, maxW];
  if (bValue == null) return [maxW, 0];
  if (aValue === bValue) return [maxW, maxW];
  if (higherIsBetter) {
    const mx = Math.max(aValue, bValue, 1e-9);
    return [(aValue / mx) * maxW, (bValue / mx) * maxW];
  }
  // lower is better: invert; guard zero-price (free vs free -> tie handled above;
  // free vs paid: free full bar, paid scaled)
  const mn = Math.min(aValue, bValue);
  if (mn <= 0) {
    // one side is 0 (free): free gets full, other gets small proportional bar
    const wa = aValue <= 0 ? maxW : Math.max(14, (mn / Math.max(aValue, 1e-9)) * maxW);
    const wb = bValue <= 0 ? maxW : Math.max(14, (mn / Math.max(bValue, 1e-9)) * maxW);
    return [wa, wb];
  }
  return [(mn / aValue) * maxW, (mn / bValue) * maxW];
}

function initials(name) {
  return String(name ?? "?")
    .split(/[\s\-_/]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

// ---------------------------------------------------------------- brand icons
// Brand badges use @lobehub/icons (see https://lobehub.com/icons/skill.md):
//  - React consumers: `ModelIcon` / `ProviderIcon` / `ProviderCombine` from `@lobehub/icons`,
//    full provider keys in `reference/providers.md`, colors/variants in `toc`.
//  - This static SVG generator cannot use React, so it inlines the mono files from
//    `@lobehub/icons-static-svg` (`icons/{id}.svg`, `fill="currentColor"` → rendered white
//    on the toc brand color). Alternative without install: `getLobeIconCDN(id, {format:'svg'})`
//    or https://unpkg.com/@lobehub/icons-static-svg@latest/icons/{id}.svg — but inlining
//    keeps badges self-contained/offline (GitHub renders <img> SVG with no network).
// Mapping is by id/name/family so future models fall back to initials.
// No LobeHub icon exists for ling / big-pickle / space-bunny / jev (verified via toc),
// those keep minimal custom white-on-color marks in the same badge style.
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

const BRAND_DEFS = [
  { keys: ["deepseek"], bg: "#4D6BFE", lobe: "deepseek" }, // toc DeepSeek
  { keys: ["muse"], bg: "#1d65c1", lobe: "meta" }, // toc Meta; Muse Spark = Meta family
  { keys: ["mimo"], bg: "#FF6900", lobe: "xiaomimimo" }, // toc XiaomiMiMo (mono only)
  { keys: ["longcat"], bg: "#111827", lobe: "longcat" }, // toc color #fff → dark badge for contrast
  { keys: ["nemotron"], bg: "#74B71B", lobe: "nvidia" }, // toc "Nvidia (Nemotron)"
  {
    keys: ["ling"],
    bg: "#0D9488",
    art: `<path d="M12 3.5 18.5 7v7L12 20.5 5.5 14V7Z" fill="none" stroke="#fff" stroke-width="1.9" stroke-linejoin="round"/><path d="M13.2 7.5 9.6 12.5h2.5l-1.1 4.5 3.6-5h-2.5Z" fill="#fff"/>`,
  },
  {
    keys: ["big-pickle", "pickle"],
    bg: "#16A34A",
    art: `<rect x="9" y="4" width="6" height="16" rx="3" fill="none" stroke="#fff" stroke-width="2"/><circle cx="12" cy="9" r="1.05" fill="#fff"/><circle cx="12" cy="12.5" r="1.05" fill="#fff"/><circle cx="12" cy="16" r="1.05" fill="#fff"/>`,
  },
  {
    keys: ["space-bunny", "bunny"],
    bg: "#9333EA",
    art: `<ellipse cx="8.8" cy="6.8" rx="1.9" ry="3.4" fill="#fff"/><ellipse cx="15.2" cy="6.8" rx="1.9" ry="3.4" fill="#fff"/><circle cx="12" cy="14.5" r="5.2" fill="none" stroke="#fff" stroke-width="2"/><path d="M8.2 14.2h7.6" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><circle cx="18.6" cy="6" r="1" fill="#fff" opacity=".9"/>`,
  },
  {
    keys: ["jev"],
    bg: "#475569",
    art: `<rect x="7" y="7" width="10" height="10" rx="2" fill="none" stroke="#fff" stroke-width="2"/><path d="M9.5 4v2.5M14.5 4v2.5M9.5 17.5V20M14.5 17.5V20M4 9.5h2.5M4 14.5h2.5M17.5 9.5H20M17.5 14.5H20" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>`,
  },
];

function brandFor(rec) {
  const hay = `${rec?.id ?? ""} ${rec?.name ?? ""} ${rec?.family ?? ""}`.toLowerCase();
  for (const b of BRAND_DEFS) {
    if (b.keys.some((k) => hay.includes(k))) return b;
  }
  return null;
}

function brandBadge(rec) {
  const b = brandFor(rec);
  if (!b) return `<circle r="21" fill="#171c23"/><text y="7" text-anchor="middle" font-size="15" font-weight="800" fill="#fff">${esc(initials(rec.name))}</text>`;
  const inner = b.lobe ? lobeArt(b.lobe) ?? b.art : b.art;
  if (!inner) return `<circle r="21" fill="${b.bg}"/><text y="7" text-anchor="middle" font-size="15" font-weight="800" fill="#fff">${esc(initials(rec.name))}</text>`;
  // LobeHub glyphs are 24x24 full-bleed; scale to ~19px optical size inside r=21 badge.
  // Custom fallback art uses the same 24 box with built-in padding, keep 1:1.
  const art = b.lobe
    ? `<g transform="translate(-9.6 -9.6) scale(0.8)" fill="#fff">${inner}</g>`
    : `<g transform="translate(-12 -12)">${inner}</g>`;
  return `<circle r="21" fill="${b.bg}"/>${art}`;
}

function renderVsSVG(a, b, rows) {
  const W = 960;
  const rowH = 56;
  const headerH = 118;
  const footerH = 108;
  const H = headerH + rows.length * rowH + footerH;
  const title = `${a.name} vs ${b.name}`;
  const wins = rows.map(winnerOf);
  const aWins = wins.filter((w) => w === "a").length;
  const bWins = wins.filter((w) => w === "b").length;
  const leader = aWins === bWins ? "Both models tie" : aWins > bWins ? a.name : b.name;

  const desc = `${esc(leader)} leads ${Math.max(aWins, bWins)} of ${rows.length} metrics. `
    + `Price ${fmtPrice(a.priceAvg)} vs ${fmtPrice(b.priceAvg)}. `
    + `Context ${fmtCtx(a.context)} vs ${fmtCtx(b.context)}.`;

  let body = "";
  rows.forEach((row, i) => {
    const y = headerH + i * rowH;
    const w = winnerOf(row);
    const [wa, wb] = barWidths(row);
    const aBarX = 380 - wa; // right-aligned toward center (left side grows leftwards)
    const aFill = w === "a" ? "url(#gWin)" : "#9aa4b0";
    const bFill = w === "b" ? "url(#gWin)" : "#9aa4b0";
    const aCls = w === "a" ? "bm" : "loser";
    const bCls = w === "b" ? "bm" : "loser";
    const delay = (0.15 + i * 0.11).toFixed(3);
    const dur = (0.95 + i * 0.15).toFixed(2);
    body += `
    <g class="ink" fill="#1f2328" text-anchor="middle" opacity="1">
      <animate attributeName="opacity" values="0;0;1" keyTimes="0;.2;1" dur=".6s" begin="${delay}s" fill="freeze"/>
      <text x="480" y="${y + 19}" font-size="15" font-weight="700">${esc(row.label)}</text>
      <text x="480" y="${y + 35}" font-size="11.5" class="mute" fill="#59636e">${esc(row.sub)}</text>
    </g>
    <rect fill="#8892a0" fill-opacity=".2" x="170" y="${y + 41 - 14}" width="210" height="14" rx="7"/>
    <rect fill="#8892a0" fill-opacity=".2" x="580" y="${y + 41 - 14}" width="210" height="14" rx="7"/>
    <rect class="${aCls}" fill="${aFill}" x="${aBarX.toFixed(2)}" y="${y + 41 - 14}" width="${wa.toFixed(2)}" height="14" rx="7">
      <animate attributeName="x" values="380;380;${aBarX.toFixed(2)}" keyTimes="0;.15;1" dur="${dur}s" begin="${delay}s" calcMode="spline" keySplines="0 0 1 1;.2 .75 .25 1" fill="freeze"/>
      <animate attributeName="width" values="0;0;${wa.toFixed(2)}" keyTimes="0;.15;1" dur="${dur}s" begin="${delay}s" calcMode="spline" keySplines="0 0 1 1;.2 .75 .25 1" fill="freeze"/>
    </rect>
    <rect class="${bCls}" fill="${bFill}" x="580" y="${y + 41 - 14}" width="${wb.toFixed(2)}" height="14" rx="7"${w !== "tie" && w === "b" ? ' filter="url(#glowW)"' : ""}${w !== "tie" && w === "a" ? "" : ""}>
      <animate attributeName="width" values="0;0;${wb.toFixed(2)}" keyTimes="0;.15;1" dur="${dur}s" begin="${delay}s" calcMode="spline" keySplines="0 0 1 1;.2 .75 .25 1" fill="freeze"/>
    </rect>
    <g class="${w === "a" ? "win" : "lose"}" fill="${w === "a" ? "#1f2328" : "#59636e"}" opacity="1"><animate attributeName="opacity" values="0;0;1" keyTimes="0;.2;1" dur=".8s" begin="${delay}s" fill="freeze"/><text x="40" y="${y + 41}" font-size="24" font-weight="800">${esc(row.aDisplay)}</text></g>
    <g class="${w === "b" ? "win" : "lose"}" fill="${w === "b" ? "#1f2328" : "#59636e"}" opacity="1"><animate attributeName="opacity" values="0;0;1" keyTimes="0;.2;1" dur=".8s" begin="${delay}s" fill="freeze"/><text x="920" y="${y + 41}" font-size="24" font-weight="800" text-anchor="end">${esc(row.bDisplay)}</text></g>
    <line stroke="#7b8794" stroke-opacity=".28" x1="64" y1="${y + rowH - 7}" x2="896" y2="${y + rowH - 7}"/>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${H}" viewBox="0 0 960 ${H}" role="img" aria-labelledby="t d">
  <title id="t">${esc(title)}</title>
  <desc id="d">${desc}</desc>
  <defs>
    <linearGradient id="gWin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4aa9ff"/><stop offset="1" stop-color="#0062dd"/></linearGradient>
    <linearGradient id="gLeft" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a545f"/><stop offset="1" stop-color="#171c23"/></linearGradient>
    <filter id="glowW" x="-30%" y="-150%" width="160%" height="400%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#0082fb" flood-opacity=".55"/></filter>
    <style><![CDATA[
      text{font-variant-numeric:tabular-nums}
      @media (prefers-color-scheme:dark){
        .ink{fill:#f0f6fc}.mute{fill:#9198a1}.win{fill:#f0f6fc}.lose{fill:#8b95a1}
      }
    ]]></style>
  </defs>
  <g font-family="ui-sans-serif,-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
    <g transform="translate(40 50)">
      ${brandBadge(a)}
    </g>
    <text x="88" y="50" class="ink" fill="#1f2328" font-size="23" font-weight="800">${esc(a.name)}</text>
    <text x="88" y="70" class="mute" fill="#59636e" font-size="13">${esc((a.family || "opencode") + (a.hf ? " · matched " + a.hf.name : " · no HF match"))}</text>
    <rect class="ink" fill="${brandFor(a)?.bg ?? "#1f2328"}" x="88" y="79" width="42" height="3" rx="1.5"/>
    <g transform="translate(580 50)">
      ${brandBadge(b)}
    </g>
    <text x="628" y="50" class="ink" fill="#1f2328" font-size="23" font-weight="800">${esc(b.name)}</text>
    <text x="628" y="70" class="mute" fill="#59636e" font-size="13">${esc((b.family || "opencode") + (b.hf ? " · matched " + b.hf.name : " · no HF match"))}</text>
    <rect fill="${brandFor(b)?.bg ?? "#0082fb"}" x="628" y="79" width="42" height="3" rx="1.5"/>
    <g transform="translate(480 49)">
      <circle r="17" fill="#8892a0" fill-opacity=".15" stroke="#8892a0" stroke-opacity=".4"/>
      <text y="4.5" text-anchor="middle" font-size="13" font-weight="800" class="mute" fill="#59636e">VS</text>
    </g>
    ${body}
    <g class="ink" fill="#1f2328" text-anchor="middle" opacity="1">
      <text x="480" y="${headerH + rows.length * rowH + 26}" font-size="15" font-weight="600">${esc(leader)} leads ${Math.max(aWins, bWins)} of ${rows.length} metrics.</text>
      <text x="480" y="${headerH + rows.length * rowH + 48}" font-size="15" font-weight="600">${esc("Longer bar means better. Missing scores render as N/A.")}</text>
    </g>
    <g class="mute" fill="#59636e" text-anchor="middle" opacity="1">
      <text x="480" y="${headerH + rows.length * rowH + 76}" font-size="12">Sources: OpenCode Zen availability, models.dev pricing/context, HF OpenEvals leaderboard. Values change as providers update.</text>
      <text x="480" y="${headerH + rows.length * rowH + 94}" font-size="12">Generated ${esc(new Date().toISOString().slice(0, 10))} · ${esc(a.id)} vs ${esc(b.id)}</text>
    </g>
  </g>
</svg>
`;
}

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "model";

// ---------------------------------------------------------------- state + readme
function loadState() {
  try {
    if (!existsSync(STATE_PATH)) return { updatedAt: null, models: {} };
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { updatedAt: null, models: {} };
  }
}

function modelStrength(rec) {
  const g = (key) => rec.hf?.benchmarks?.[key]?.score ?? null;
  const swe = g("sweVerified") ?? g("swePro") ?? -1;
  const term = g("terminalBench") ?? -1;
  const agg = rec.hf?.aggregateScore ?? -1;
  const ctx = rec.context ?? -1;
  // price lower is better; free (0) beats paid; null (unknown) ranks last
  const price = rec.priceAvg == null ? -1e9 : -rec.priceAvg;
  return { agg, swe, term, ctx, price };
}

function compareStrength(a, b) {
  const sa = modelStrength(a);
  const sb = modelStrength(b);
  if (sb.agg !== sa.agg) return sb.agg - sa.agg;
  if (sb.swe !== sa.swe) return sb.swe - sa.swe;
  if (sb.term !== sa.term) return sb.term - sa.term;
  if (sb.ctx !== sa.ctx) return sb.ctx - sa.ctx;
  if (sb.price !== sa.price) return sb.price - sa.price;
  // active beats deprecated, then stable id order
  const st = (r) => (r.status === "deprecated" ? 0 : 1);
  if (st(b) !== st(a)) return st(b) - st(a);
  return a.id.localeCompare(b.id);
}

function updateReadme(pairs) {
  // pairs: [{a, b, file}] current live comparisons
  // Rank: best `a` first so 2 perbandingan paling unggul berada di utama.
  const ranked = [...pairs].sort((p, q) => compareStrength(p.a, q.a));
  const topIds = new Set(ranked.slice(0, 2).map((p) => `${p.a.id}||${p.b.id}`));
  const START = "<!-- BENCHMARK:START -->";
  const END = "<!-- BENCHMARK:END -->";
  let md = "";
  try {
    md = readFileSync(README_PATH, "utf8");
  } catch {
    md = "# Benchmarks\n";
  }
  const section = [
    START,
    "",
    "## Model benchmarks (OpenCode Zen free)",
    "",
    `> Auto-generated ${new Date().toISOString().slice(0, 10)}. Each new free model is compared vs the current baseline. Removed/paid models are pruned. Ranked best-first; top 2 pinned as featured.`,
    "",
    "### Featured: top 2 perbandingan paling unggul",
    "",
    ...ranked.slice(0, 2).flatMap(({ a, b, file }, i) => [
      `#### ${i + 1}. ${a.name} vs ${b.name} ⭐ Top ${i + 1}`,
      "",
      `<p align="center">`,
      `  <img src="./${file}?v=${Date.now().toString(36)}" alt="${esc(`${a.name} vs ${b.name}: intelligence, coding benchmarks, price, and context window`)}" width="100%">`,
      `</p>`,
      "",
    ]),
    "### All comparisons (ranked)",
    "",
    ...ranked.flatMap(({ a, b, file }, i) => [
      `### ${i + 1}. ${a.name} vs ${b.name}${topIds.has(`${a.id}||${b.id}`) ? ` ⭐ Top ${i + 1}` : ""}`,
      "",
      `<p align="center">`,
      `  <img src="./${file}?v=${Date.now().toString(36)}" alt="${esc(`${a.name} vs ${b.name}: intelligence, coding benchmarks, price, and context window`)}" width="100%">`,
      `</p>`,
      "",
      `| metric | ${a.name} | ${b.name} |`,
      `|---|---|---|`,
      ...buildRows(a, b).map(
        (r) => `| ${r.label} | ${r.aDisplay} | ${r.bDisplay} |`
      ),
      "",
    ]),
    `Sources: OpenCode Zen, models.dev, HF OpenEvals/OpenEvals/leaderboard-data.`,
    "",
    END,
  ].join("\n");

  if (md.includes(START) && md.includes(END)) {
    const re = new RegExp(`${START}[\\s\\S]*?${END}`, "m");
    md = md.replace(re, () => section);
  } else {
    md = md.replace(/\s+$/, "") + "\n\n" + section + "\n";
  }
  if (!DRY_RUN) writeFileSync(README_PATH, md);
  return section;
}

// ---------------------------------------------------------------- main
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[info] fetching Zen + models.dev + leaderboard...`);
  const [zenIds, devModels, lb] = await Promise.all([
    fetchZenIds(),
    fetchModelsDev(),
    fetchLeaderboard(),
  ]);
  const records = buildRecords(zenIds, devModels, lb.models ?? []);
  console.log(`[info] zen=${zenIds.length} free=${records.size} leaderboard=${lb.models?.length ?? 0}`);

  const prev = loadState();
  const prevIds = new Set(Object.keys(prev.models ?? {}));
  const curIds = new Set(records.keys());
  const added = [...curIds].filter((id) => !prevIds.has(id));
  const removed = [...prevIds].filter((id) => !curIds.has(id));
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
  const livePairs = [];
  for (const rec of records.values()) {
    const base = pickBaseline(rec.id, records);
    if (!base) continue;
    livePairs.push({ a: rec, b: base, file: `data/${slug(rec.id)}-vs-${slug(base.id)}.svg` });
  }

  for (const rec of targets) {
    const base = pickBaseline(rec.id, records);
    if (!base) {
      console.log(`[skip] ${rec.id}: no baseline (only free model)`);
      continue;
    }
    const rows = buildRows(rec, base);
    const svg = renderVsSVG(rec, base, rows);
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
