import { readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { closeDb, db } from "../lib/db.ts";
import { normKeyword } from "../lib/dfs.ts";
import { estTraffic, score } from "./score.ts";

const DIR = "out/cluster";

const Result = z.object({
  batch: z.number().int(),
  dropped: z.array(z.object({ id: z.number().int(), reason: z.enum(["off_topic", "ymyl_no_author", "competitor_brand", "other_city", "duplicate_of_ours", "thin_topic"]) })),
  clusters: z.array(
    z.object({
      primary_keyword: z.string().min(2).max(80),
      intent: z.enum(["informational", "commercial", "transactional", "navigational"]),
      topic_ids: z.array(z.number().int()).min(1),
      fit: z.number().int().min(0).max(5),
      gain: z.number().int().min(0).max(5),
      ymyl: z.boolean(),
      rationale: z.string().min(10).max(600),
    }),
  ),
});

type Cluster = z.infer<typeof Result>["clusters"][number];

const files = readdirSync(DIR).filter((f) => /^result_\d+\.json$/.test(f));
if (!files.length) {
  console.error(`No ${DIR}/result_<n>.json files; run the clusterer agent first`);
  process.exit(1);
}

const merged = new Map<string, Cluster>();
const dropped = new Map<number, string>();
for (const f of files) {
  const parsed = Result.safeParse(JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")));
  if (!parsed.success) {
    console.error(`${f}: ${parsed.error.message}`);
    process.exit(1);
  }
  for (const d of parsed.data.dropped) dropped.set(d.id, d.reason);
  for (const c of parsed.data.clusters) {
    const key = normKeyword(c.primary_keyword);
    const prev = merged.get(key);
    merged.set(
      key,
      prev
        ? { ...prev, topic_ids: [...new Set([...prev.topic_ids, ...c.topic_ids])], fit: Math.min(prev.fit, c.fit), gain: Math.max(prev.gain, c.gain), ymyl: prev.ymyl || c.ymyl }
        : { ...c, primary_keyword: key },
    );
  }
}

const sql = db();
const ids = [...new Set([...merged.values()].flatMap((c) => c.topic_ids))];
const topics = new Map(
  (await sql<{ id: number; volume: number | null; kd: number | null; traffic: number | null }[]>`
    select id::int as id, volume, kd::float8 as kd, traffic::float8 as traffic from heist.topics where id = any(${ids}::bigint[]) and status = 'new'`).map((t) => [t.id, t]),
);
const doubled = ids.filter((id) => [...merged.values()].filter((c) => c.topic_ids.includes(id)).length > 1);
if (doubled.length) console.warn(`warn: ${doubled.length} topic(s) assigned to more than one cluster: ${doubled.slice(0, 10).join(", ")}`);

let upserted = 0;
await sql.begin(async (tx) => {
  for (const [id, reason] of dropped) await tx`update heist.topics set status = 'dropped', drop_reason = ${reason} where id = ${id} and status = 'new'`;
  for (const c of merged.values()) {
    const rows = c.topic_ids.map((id) => topics.get(id)).filter((t) => t != null);
    if (!rows.length) continue;
    const kds = rows.map((r) => r.kd).filter((k): k is number => k != null);
    const kd = kds.length ? Math.round(Math.max(...kds)) : null;
    const est = estTraffic(rows);
    const res = await tx`
      insert into heist.clusters (primary_keyword, intent, topic_ids, est_traffic, kd, fit, gain, score, ymyl, rationale)
      values (${c.primary_keyword}, ${c.intent}, ${rows.map((r) => r.id)}, ${est}, ${kd}, ${c.fit}, ${c.gain}, ${score({ est_traffic: est, kd, fit: c.fit, gain: c.gain })}, ${c.ymyl}, ${c.rationale})
      on conflict (primary_keyword) do update set topic_ids = (select array_agg(distinct x) from unnest(heist.clusters.topic_ids || excluded.topic_ids) x),
        intent = excluded.intent, est_traffic = excluded.est_traffic, kd = excluded.kd, fit = excluded.fit, gain = excluded.gain, score = excluded.score,
        ymyl = heist.clusters.ymyl or excluded.ymyl, rationale = excluded.rationale
      where heist.clusters.status = 'candidate'
      returning id`;
    upserted += res.length;
    await tx`update heist.topics set status = 'kept' where id = any(${rows.map((r) => r.id)}::bigint[]) and status = 'new'`;
  }
});
console.log(`${upserted} of ${merged.size} clusters upserted, ${dropped.size} topics dropped by the clusterer`);
await closeDb();
