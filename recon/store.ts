import type { Sql } from "../lib/db.ts";
import { classify, discover, slugToTopic } from "./sitemap.ts";

export type Site = { domain: string; role: "ours" | "competitor"; scope_prefix: string | null };

export async function sites(db: Sql, role?: Site["role"], only?: string) {
  const rows = await db<Site[]>`select domain, role, scope_prefix from heist.sites where active ${role ? db`and role = ${role}` : db``} order by domain`;
  return only ? rows.filter((s) => s.domain === only) : rows;
}

export async function crawlSitemaps(db: Sql, site: Site) {
  const found = await discover(site.domain, site.scope_prefix);
  const rows = found.urls.map((u) => {
    const c = classify(u.url, site.scope_prefix);
    return { domain: site.domain, url: u.url, lastmod: u.lastmod, topic: slugToTopic(u.url), kept: c.kept, drop_reason: c.reason };
  });
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const res: { inserted: boolean }[] = await db`
      insert into heist.sitemap_urls ${db(chunk, ["domain", "url", "lastmod", "topic", "kept", "drop_reason"])}
      on conflict (domain, url) do update set lastmod = excluded.lastmod, topic = excluded.topic, kept = excluded.kept, drop_reason = excluded.drop_reason, last_seen = now()
      returning (xmax = 0) as inserted`;
    inserted += res.filter((r) => r.inserted).length;
  }
  return { ...found, rows, inserted };
}
