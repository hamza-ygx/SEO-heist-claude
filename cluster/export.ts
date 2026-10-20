import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { closeDb, db } from "../lib/db.ts";

const BATCH = 200;
const DIR = "out/cluster";

const sql = db();
const [settings] = await sql<{ min_volume: number }[]>`select min_volume from heist.settings`;
const minVolume = settings?.min_volume ?? 50;

const pre = await sql<{ reason: string; n: number }[]>`
  with upd as (
    update heist.topics t set status = 'dropped', drop_reason = case
        when coalesce(t.traffic, 0) <= 0 and coalesce(t.volume, 0) < ${minVolume} then 'no_demand'
        when t.our_position between 1 and 20 then 'we_rank_page_1_2'
      end
    where t.status = 'new'
      and ((coalesce(t.traffic, 0) <= 0 and coalesce(t.volume, 0) < ${minVolume}) or t.our_position between 1 and 20)
    returning drop_reason
  )
  select drop_reason as reason, count(*)::int as n from upd group by 1`;
for (const p of pre) console.log(`pre-filter dropped ${p.n} (${p.reason})`);

const rows = await sql<{ id: number; domain: string; topic: string; top_keyword: string | null; volume: number | null; kd: number | null; traffic: number | null; our_position: number | null }[]>`
  select id::int as id, domain, topic, top_keyword, volume, kd::float8 as kd, traffic::float8 as traffic, our_position
  from heist.topics where status = 'new'
  order by coalesce(traffic, 0) desc, coalesce(volume, 0) desc`;
const ours = await sql<{ topic: string }[]>`
  select s.topic from heist.sitemap_urls s join heist.sites x on x.domain = s.domain where x.role = 'ours' and s.kept`;

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
const batches = Math.ceil(rows.length / BATCH);
for (let b = 0; b < batches; b++) {
  writeFileSync(`${DIR}/batch_${b + 1}.json`, JSON.stringify({ batch: b + 1, of: batches, our_existing_topics: ours.map((o) => o.topic), topics: rows.slice(b * BATCH, (b + 1) * BATCH) }, null, 1));
}
console.log(`${rows.length} topics → ${batches} batch file(s) in ${DIR}/ (≤${BATCH} rows each)`);
await closeDb();
