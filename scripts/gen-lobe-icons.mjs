import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = "node_modules/@lobehub/icons-static-svg/icons";
const slugs = ["deepseek", "meta", "xiaomimimo", "longcat", "nvidia"];
const out = {};
for (const s of slugs) {
  const raw = readFileSync(join(dir, `${s}.svg`), "utf8");
  const m = raw.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i);
  out[s] = m[1].replace(/<title>[\s\S]*?<\/title>/gi, "").replaceAll("currentColor", "#fff").trim();
  console.log(s, out[s].length);
}
writeFileSync(
  "worker/src/lobe-icons.js",
  `${Object.entries(out).map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`).join("\n")}\n\nexport const LOBE_INNERS = {\n${Object.keys(out).map((k) => `  ${k},`).join("\n")}\n};\n`
);
console.log("wrote worker/src/lobe-icons.js");
