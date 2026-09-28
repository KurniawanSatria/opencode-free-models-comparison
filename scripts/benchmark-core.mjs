export const ZEN_API = "https://opencode.ai/zen/v1/models";
export const MODELS_DEV_API = "https://models.dev/api.json";
export const HF_LEADERBOARD_URL =
  "https://huggingface.co/datasets/OpenEvals/leaderboard-data/resolve/main/leaderboard.json";

export async function getJSON(url, headers = {}) {
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

export const normalize = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
export const stripFree = (id) =>
  String(id ?? "")
    .toLowerCase()
    .replace(/-contributor-free$/, "")
    .replace(/-free$/, "");

export function findLeaderboardEntry(opencodeId, leaderboardModels) {
  const base = normalize(stripFree(opencodeId));
  if (!base || base.length < 4) return null;
  for (const m of leaderboardModels) {
    const nid = normalize(m.id);
    const nname = normalize(m.name);
    if (nid === base || nname === base) return m;
  }
  let best = null;
  for (const m of leaderboardModels) {
    const nid = normalize(m.id);
    const nname = normalize(m.name);
    if (nid.length < 6 && nname.length < 6) continue;
    if (nid.includes(base) || base.includes(nid) || nname.includes(base) || base.includes(nname)) {
      const score = Math.max(
        nid.includes(base) ? base.length : 0,
        nname.includes(base) ? base.length : 0
      );
      if (!best || score > best.score) best = { m, score };
    }
  }
  return best?.m ?? null;
}

export async function fetchZenIds(authHeaders = {}) {
  const j = await getJSON(ZEN_API, authHeaders);
  const data = Array.isArray(j) ? j : j.data;
  if (!Array.isArray(data)) throw new Error("unexpected Zen shape: " + JSON.stringify(j).slice(0, 300));
  return data.map((m) => m.id).filter(Boolean);
}

export async function fetchModelsDev() {
  const j = await getJSON(MODELS_DEV_API);
  const oc = j?.opencode?.models;
  if (!oc || typeof oc !== "object") throw new Error("models.dev missing opencode.models");
  return oc;
}

export async function fetchLeaderboard(authHeaders = {}) {
  try {
    const j = await getJSON(HF_LEADERBOARD_URL, authHeaders);
    if (!Array.isArray(j.models)) throw new Error("leaderboard.models missing");
    return j;
  } catch (e) {
    console.warn(`[warn] leaderboard unavailable, continue without scores: ${e.message}`);
    return { metadata: {}, benchmarks: {}, models: [] };
  }
}

export const isFreeId = (id) => id === "big-pickle" || String(id).endsWith("-free");

export function buildRecords(zenIds, devModels, lbModels) {
  const zenSet = new Set(zenIds);
  const out = new Map();
  for (const id of zenSet) {
    if (!isFreeId(id)) continue;
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

export function pickBaseline(selfId, records) {
  const others = [...records.values()].filter((r) => r.id !== selfId);
  if (!others.length) return null;
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

export function diffIds(prevIds, curIds) {
  const p = new Set(prevIds);
  const c = new Set(curIds);
  return {
    added: [...c].filter((id) => !p.has(id)),
    removed: [...p].filter((id) => !c.has(id)),
  };
}

export function buildLivePairs(records) {
  const pairs = [];
  for (const rec of records.values()) {
    const base = pickBaseline(rec.id, records);
    if (!base) continue;
    pairs.push({ a: rec, b: base, file: `data/${slug(rec.id)}-vs-${slug(base.id)}.svg` });
  }
  return pairs;
}

export const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function fmtCtx(v) {
  if (v == null) return "N/A";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}K`;
  return String(v);
}
export function fmtPrice(v) {
  if (v == null) return "N/A";
  return `$${Number(v).toFixed(2)}`;
}
export function fmtScore(v, suffix = "") {
  if (v == null) return "N/A";
  const n = Number(v);
  const s = Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
  return s + suffix;
}

export function buildRows(a, b) {
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

export function winnerOf(row) {
  const { aValue, bValue, higherIsBetter } = row;
  if (aValue == null && bValue == null) return "tie";
  if (aValue == null) return "b";
  if (bValue == null) return "a";
  if (aValue === bValue) return "tie";
  const aWins = higherIsBetter ? aValue > bValue : aValue < bValue;
  return aWins ? "a" : "b";
}

export function barWidths(row, maxW = 210) {
  const { aValue, bValue, higherIsBetter } = row;
  if (aValue == null && bValue == null) return [0, 0];
  if (aValue == null) return [0, maxW];
  if (bValue == null) return [maxW, 0];
  if (aValue === bValue) return [maxW, maxW];
  if (higherIsBetter) {
    const mx = Math.max(aValue, bValue, 1e-9);
    return [(aValue / mx) * maxW, (bValue / mx) * maxW];
  }
  const mn = Math.min(aValue, bValue);
  if (mn <= 0) {
    const wa = aValue <= 0 ? maxW : Math.max(14, (mn / Math.max(aValue, 1e-9)) * maxW);
    const wb = bValue <= 0 ? maxW : Math.max(14, (mn / Math.max(bValue, 1e-9)) * maxW);
    return [wa, wb];
  }
  return [(mn / aValue) * maxW, (mn / bValue) * maxW];
}

export function initials(name) {
  return String(name ?? "?")
    .split(/[\s\-_/]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

export const BRAND_DEFS = [
  { keys: ["deepseek"], bg: "#4D6BFE", lobe: "deepseek" },
  { keys: ["muse"], bg: "#1d65c1", lobe: "meta" },
  { keys: ["mimo"], bg: "#FF6900", lobe: "xiaomimimo" },
  { keys: ["longcat"], bg: "#111827", lobe: "longcat" },
  { keys: ["nemotron"], bg: "#74B71B", lobe: "nvidia" },
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

export function brandFor(rec) {
  const hay = `${rec?.id ?? ""} ${rec?.name ?? ""} ${rec?.family ?? ""}`.toLowerCase();
  for (const b of BRAND_DEFS) {
    if (b.keys.some((k) => hay.includes(k))) return b;
  }
  return null;
}

export function brandBadge(rec, resolveLobe = () => null) {
  const b = brandFor(rec);
  if (!b) return `<circle r="21" fill="#171c23"/><text y="7" text-anchor="middle" font-size="15" font-weight="800" fill="#fff">${esc(initials(rec.name))}</text>`;
  const inner = b.lobe ? resolveLobe(b.lobe) ?? b.art : b.art;
  if (!inner) return `<circle r="21" fill="${b.bg}"/><text y="7" text-anchor="middle" font-size="15" font-weight="800" fill="#fff">${esc(initials(rec.name))}</text>`;
  const art = b.lobe
    ? `<g transform="translate(-9.6 -9.6) scale(0.8)" fill="#fff">${inner}</g>`
    : `<g transform="translate(-12 -12)">${inner}</g>`;
  return `<circle r="21" fill="${b.bg}"/>${art}`;
}

export function renderVsSVG(a, b, rows, resolveLobe = () => null, dateStr = new Date().toISOString().slice(0, 10)) {
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
    const aBarX = 380 - wa;
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
      ${brandBadge(a, resolveLobe)}
    </g>
    <text x="88" y="50" class="ink" fill="#1f2328" font-size="23" font-weight="800">${esc(a.name)}</text>
    <text x="88" y="70" class="mute" fill="#59636e" font-size="13">${esc((a.family || "opencode") + (a.hf ? " · matched " + a.hf.name : " · no HF match"))}</text>
    <rect class="ink" fill="${brandFor(a)?.bg ?? "#1f2328"}" x="88" y="79" width="42" height="3" rx="1.5"/>
    <g transform="translate(580 50)">
      ${brandBadge(b, resolveLobe)}
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
      <text x="480" y="${headerH + rows.length * rowH + 94}" font-size="12">Generated ${esc(dateStr)} · ${esc(a.id)} vs ${esc(b.id)}</text>
    </g>
  </g>
</svg>
`;
}

export const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "model";

export function modelStrength(rec) {
  const g = (key) => rec.hf?.benchmarks?.[key]?.score ?? null;
  const swe = g("sweVerified") ?? g("swePro") ?? -1;
  const term = g("terminalBench") ?? -1;
  const agg = rec.hf?.aggregateScore ?? -1;
  const ctx = rec.context ?? -1;
  const price = rec.priceAvg == null ? -1e9 : -rec.priceAvg;
  return { agg, swe, term, ctx, price };
}

export function compareStrength(a, b) {
  const sa = modelStrength(a);
  const sb = modelStrength(b);
  if (sb.agg !== sa.agg) return sb.agg - sa.agg;
  if (sb.swe !== sa.swe) return sb.swe - sa.swe;
  if (sb.term !== sa.term) return sb.term - sa.term;
  if (sb.ctx !== sa.ctx) return sb.ctx - sa.ctx;
  if (sb.price !== sa.price) return sb.price - sa.price;
  const st = (r) => (r.status === "deprecated" ? 0 : 1);
  if (st(b) !== st(a)) return st(b) - st(a);
  return a.id.localeCompare(b.id);
}

export const README_START = "<!-- BENCHMARK:START -->";
export const README_END = "<!-- BENCHMARK:END -->";

export function buildReadmeSection(pairs, { dateStr, cacheBuster }) {
  const ranked = [...pairs].sort((p, q) => compareStrength(p.a, q.a));
  const topIds = new Set(ranked.slice(0, 2).map((p) => `${p.a.id}||${p.b.id}`));
  return [
    README_START,
    "",
    "## Model benchmarks (OpenCode Zen free)",
    "",
    `> Auto-generated ${dateStr}. Each new free model is compared vs the current baseline. Removed/paid models are pruned. Ranked best-first; top 2 pinned as featured.`,
    "",
    "### Featured: top 2 perbandingan paling unggul",
    "",
    ...ranked.slice(0, 2).flatMap(({ a, b, file }, i) => [
      `#### ${i + 1}. ${a.name} vs ${b.name} ⭐ Top ${i + 1}`,
      "",
      `<p align="center">`,
      `  <img src="./${file}?v=${cacheBuster}" alt="${esc(`${a.name} vs ${b.name}: intelligence, coding benchmarks, price, and context window`)}" width="100%">`,
      `</p>`,
      "",
    ]),
    "### All comparisons (ranked)",
    "",
    ...ranked.flatMap(({ a, b, file }, i) => [
      `### ${i + 1}. ${a.name} vs ${b.name}${topIds.has(`${a.id}||${b.id}`) ? ` ⭐ Top ${i + 1}` : ""}`,
      "",
      `<p align="center">`,
      `  <img src="./${file}?v=${cacheBuster}" alt="${esc(`${a.name} vs ${b.name}: intelligence, coding benchmarks, price, and context window`)}" width="100%">`,
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
    README_END,
  ].join("\n");
}

export function spliceReadmeSection(md, section) {
  if (md.includes(README_START) && md.includes(README_END)) {
    const re = new RegExp(`${README_START}[\\s\\S]*?${README_END}`, "m");
    return md.replace(re, () => section);
  }
  return md.replace(/\s+$/, "") + "\n\n" + section + "\n";
}
