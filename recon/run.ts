import { parseArgs } from "node:util";
import { closeDb, db } from "../lib/db.ts";
import { writeCsv } from "../lib/csv.ts";
import { bareDomain, keywordMetrics, normKeyword, rankedKeywords, relevantPages, spentThisMonth, type RankedKeyword } from "../lib/dfs.ts";
import { OUR_SITE } from "../lib/env.ts";
import { urlKey } from "./sitemap.ts";
import { crawlSitemaps, sites, type Site } from "./store.ts";

const { values } = parseArgs({ options: { competitor: { type: "string" }, all: { type: "boolean", default: false }, "no-enrich": { type: "boolean", default: false } } });
if (!values.competitor && !values.all) {
  console.error("usage: npm run recon -- --competitor <domain> | --all [--no-enrich]");
  process.exit(1);
}

type OurRank = { position: number; url: string | null };

async function ourRankings(sql: ReturnType<typeof db>): Promise<Map<string, OurRank>> {
  const out = new Map<string, OurRank>();
  const gsc = await sql<{ query: string; position: number; page: string }[]>`
    select g.query, (sum(g.position * g.impressions) / nullif(sum(g.impressions), 0))::float8 as position,
           (array_agg(g.page order by g.impressions desc))[1] as page
    from public.gsc_query_daily g join public.projects p on p.id = g.project_id
    where regexp_replace(p.domain, '^www\\.', '') = ${bareDomain(OUR_SITE)} and g.date >= current_date - 28
    group by g.query having sum(g.impressions) > 0`;
  for (const r of gsc) out.set(normKeyword(r.query), { position: Math.round(r.position), url: r.page });
  for (const k of await rankedKeywords(sql, OUR_SITE, 1000)) {
    const key = normKeyword(k.keyword);
    const prev = out.get(key);
    if (k.position != null && (!prev || k.position < prev.position)) out.set(key, { position: k.position, url: k.url });
  }
  return out;
}

async function enrich(sql: ReturnType<typeof db>, site: Site, kept: { url: string; topic: string }[], ours: Map<string, OurRank>) {
  const inScope = (url: string) => !site.scope_prefix || new URL(url).pathname.startsWith(site.scope_prefix);
  const pages = new Map((await relevantPages(sql, site.domain, 1000)).filter((p) => inScope(p.url)).map((p) => [urlKey(p.url), p]));
  const bestByUrl = new Map<string, RankedKeyword>();
  for (const k of await rankedKeywords(sql, site.domain, 1000)) {
    if (!k.url || !inScope(k.url)) continue;
    const key = urlKey(k.url);
    const prev = bestByUrl.get(key);
    if (!prev || (k.etv ?? 0) > (prev.etv ?? 0)) bestByUrl.set(key, k);
  }
  const unranked = kept.filter((r) => !bestByUrl.has(urlKey(r.url))).map((r) => r.topic);
  const topicMetrics = await keywordMetrics(sql, unranked);
  return kept.map((r) => {
    const key = urlKey(r.url);
    const best = bestByUrl.get(key);
    const metric = best ?? topicMetrics.get(normKeyword(r.topic));
    const keyword = best?.keyword ?? (metric ? r.topic : null);
    const our = keyword ? ours.get(normKeyword(keyword)) : undefined;
    return {
      domain: site.domain,
      url: r.url,
      topic: r.topic,
      top_keyword: keyword,
      volume: metric?.volume ?? null,
      kd: metric?.kd ?? null,
      traffic: pages.get(key)?.etv ?? best?.etv ?? null,
      our_position: our?.position ?? null,
      our_url: our?.url ?? null,
    };
  });
}

const sql = db();
const targets = await sites(sql, "competitor", values.competitor ? bareDomain(values.competitor) : undefined);
if (!targets.length) {
  console.error(`No active competitor ${values.competitor ?? ""} in heist.sites`);
  process.exit(1);
}
const ours = values["no-enrich"] ? new Map<string, OurRank>() : await ourRankings(sql);
const today = new Date().toISOString().slice(0, 10);

for (const site of targets) {
  const spentBefore = await spentThisMonth(sql);
  const [run] = await sql<{ id: number }[]>`insert into heist.recon_runs (domain) values (${site.domain}) returning id`;
  try {
    const crawl = await crawlSitemaps(sql, site);
    const kept = crawl.rows.filter((r) => r.kept);
    let topics: Awaited<ReturnType<typeof enrich>> = kept.map((r) => ({ domain: site.domain, url: r.url, topic: r.topic, top_keyword: null, volume: null, kd: null, traffic: null, our_position: null, our_url: null }));
    if (!values["no-enrich"]) topics = await enrich(sql, site, kept, ours);
    for (let i = 0; i < topics.length; i += 1000) {
      const chunk = topics.slice(i, i + 1000);
      await sql`
        insert into heist.topics ${sql(chunk, "domain", "url", "topic", "top_keyword", "volume", "kd", "traffic", "our_position", "our_url")}
        on conflict (domain, url) do update set topic = excluded.topic, top_keyword = coalesce(excluded.top_keyword, heist.topics.top_keyword),
          volume = coalesce(excluded.volume, heist.topics.volume), kd = coalesce(excluded.kd, heist.topics.kd), traffic = coalesce(excluded.traffic, heist.topics.traffic),
          our_position = excluded.our_position, our_url = excluded.our_url, fetched_at = now()`;
    }
    const file = `out/recon_${site.domain}_${today}.csv`;
    writeCsv(file, topics, ["url", "topic", "top_keyword", "volume", "kd", "traffic", "our_position", "our_url"]);
    const spend = (await spentThisMonth(sql)) - spentBefore;
    await sql`update heist.recon_runs set finished_at = now(), sitemaps = ${crawl.sitemaps.length}, urls = ${crawl.rows.length}, kept = ${kept.length}, new_urls = ${crawl.inserted}, spend_usd = ${spend}, warnings = ${crawl.warnings} where id = ${run!.id}`;
    console.log(`${site.domain}: ${crawl.sitemaps.length} sitemaps, ${crawl.rows.length} URLs, ${kept.length} kept, ${crawl.inserted} new, $${spend.toFixed(4)} → ${file}`);
    for (const w of crawl.warnings) console.log(`  warn: ${w}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sql`update heist.recon_runs set finished_at = now(), error = ${message.slice(0, 500)} where id = ${run!.id}`;
    console.error(`${site.domain}: ${message}`);
    process.exitCode = 1;
  }
}
await closeDb();
