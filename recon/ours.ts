import { closeDb, db } from "../lib/db.ts";
import { crawlSitemaps, sites } from "./store.ts";

const sql = db();
for (const site of await sites(sql, "ours")) {
  const crawl = await crawlSitemaps(sql, site);
  const kept = crawl.rows.filter((r) => r.kept).length;
  console.log(`${site.domain}: ${crawl.sitemaps.length} sitemaps, ${crawl.rows.length} URLs, ${kept} article-like, ${crawl.inserted} new`);
  for (const w of crawl.warnings) console.log(`  warn: ${w}`);
}
await closeDb();
