import { writeFileSync } from "node:fs";
import { closeDb, db } from "../lib/db.ts";

const sql = db();
const rows = await sql<{ id: number; primary_keyword: string; intent: string; topics: number; est_traffic: number; kd: number | null; fit: number; gain: number; score: number; ymyl: boolean; rationale: string }[]>`
  select id::int as id, primary_keyword, intent, cardinality(topic_ids)::int as topics, est_traffic::float8 as est_traffic, kd::float8 as kd, fit, gain, score::float8 as score, ymyl, rationale
  from heist.clusters where status = 'candidate' order by score desc nulls last limit 30`;
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const table = [
  "| # | id | Primary keyword | Intent | Topics | Est. traffic | KD | Fit | Gain | Score | YMYL | Why |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r, i) => `| ${i + 1} | ${r.id} | ${esc(r.primary_keyword)} | ${r.intent} | ${r.topics} | ${r.est_traffic} | ${r.kd ?? "–"} | ${r.fit} | ${r.gain} | ${r.score} | ${r.ymyl ? "yes" : ""} | ${esc(r.rationale)} |`),
].join("\n");
const file = `out/clusters_top30_${new Date().toISOString().slice(0, 10)}.md`;
writeFileSync(file, `# Top 30 clusters\n\nPick by id with \`npm run cluster:pick -- <id> <id> ...\`.\n\n${table}\n`);
console.log(table);
console.log(`\n→ ${file}`);
await closeDb();
