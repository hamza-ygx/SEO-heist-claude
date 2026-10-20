import { XMLParser } from "fast-xml-parser";
import { politeGet, robotsFor, RobotsDenied } from "../lib/fetch.ts";
import { bareDomain } from "../lib/dfs.ts";

export const MAX_URLS_PER_FILE = 50_000;
const MAX_SITEMAP_FILES = 500;

export type SitemapUrl = { url: string; lastmod: string | null };
export type Discovery = { domain: string; sitemaps: string[]; urls: SitemapUrl[]; warnings: string[] };

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, trimValues: true, processEntities: true, isArray: (name) => name === "url" || name === "sitemap" });

export const sameSiteAs = (domain: string) => (host: string) => bareDomain(host) === bareDomain(domain);

const trackingParams = /^(utm_[a-z]+|gclid|fbclid|mc_[a-z]+|ref)$/i;

export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    for (const k of [...u.searchParams.keys()]) if (trackingParams.test(k)) u.searchParams.delete(k);
    if (u.pathname.length > 1 && !/\.[a-z0-9]{2,5}$/i.test(u.pathname) && !u.pathname.endsWith("/")) u.pathname += "/";
    return u.toString();
  } catch {
    return null;
  }
}

export const urlKey = (url: string) => {
  const n = normalizeUrl(url);
  if (!n) return url;
  const u = new URL(n);
  return `${bareDomain(u.hostname)}${u.pathname.toLowerCase()}${u.search}`;
};

function parseSitemap(xml: string): { kind: "index" | "urlset" | "unknown"; locs: SitemapUrl[] } {
  const doc = parser.parse(xml) as Record<string, { sitemap?: { loc?: unknown; lastmod?: unknown }[]; url?: { loc?: unknown; lastmod?: unknown }[] }>;
  const pick = (rows: { loc?: unknown; lastmod?: unknown }[] | undefined) =>
    (rows ?? []).filter((r) => typeof r.loc === "string").map((r) => ({ url: String(r.loc), lastmod: r.lastmod == null ? null : String(r.lastmod) }));
  if (doc.sitemapindex) return { kind: "index", locs: pick(doc.sitemapindex.sitemap) };
  if (doc.urlset) return { kind: "urlset", locs: pick(doc.urlset.url) };
  return { kind: "unknown", locs: [] };
}

export async function discover(domain: string, scopePrefix: string | null = null): Promise<Discovery> {
  const host = bareDomain(domain);
  const sameSite = sameSiteAs(host);
  const warnings: string[] = [];
  const origins = [`https://www.${host}`, `https://${host}`];
  let seeds: string[] = [];
  let fallback = false;
  for (const origin of origins) {
    const robots = await robotsFor(origin);
    if (robots.status === 0) continue;
    fallback = !robots.sitemaps.length;
    seeds = fallback ? ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml"].map((p) => new URL(p, origin).toString()) : robots.sitemaps;
    break;
  }
  if (!seeds.length) throw new Error(`robots.txt unreachable for ${host}; refusing to crawl`);

  const queue = [...seeds];
  const visited = new Set<string>();
  const found = new Map<string, SitemapUrl>();
  const sitemaps: string[] = [];
  while (queue.length && visited.size < MAX_SITEMAP_FILES) {
    const sm = queue.shift()!;
    if (visited.has(sm)) continue;
    visited.add(sm);
    let parsed: ReturnType<typeof parseSitemap>;
    try {
      const res = await politeGet(sm, { sameSite });
      if (res.status !== 200) {
        if (!(fallback && seeds.includes(sm) && res.status === 404)) warnings.push(`${sm}: HTTP ${res.status}`);
        continue;
      }
      parsed = parseSitemap(res.text);
    } catch (e) {
      warnings.push(`${sm}: ${e instanceof RobotsDenied ? "disallowed by robots.txt" : e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    sitemaps.push(sm);
    if (parsed.kind === "index") {
      for (const child of parsed.locs) if (sameSite(new URL(child.url, sm).hostname)) queue.push(new URL(child.url, sm).toString());
      continue;
    }
    if (parsed.locs.length > MAX_URLS_PER_FILE) warnings.push(`${sm}: ${parsed.locs.length} URLs exceeds the ${MAX_URLS_PER_FILE} limit; truncated`);
    for (const loc of parsed.locs.slice(0, MAX_URLS_PER_FILE)) {
      const url = normalizeUrl(loc.url);
      if (!url || !sameSite(new URL(url).hostname)) continue;
      if (scopePrefix && !new URL(url).pathname.startsWith(scopePrefix)) continue;
      const key = urlKey(url);
      const prev = found.get(key);
      if (!prev || (loc.lastmod && (!prev.lastmod || loc.lastmod > prev.lastmod))) found.set(key, { url, lastmod: loc.lastmod });
    }
  }
  if (queue.length) warnings.push(`Stopped after ${MAX_SITEMAP_FILES} sitemap files`);
  return { domain: host, sitemaps, urls: [...found.values()], warnings };
}

const nonArticle: [RegExp, string][] = [
  [/\.(jpe?g|png|gif|webp|svg|avif|ico|pdf|docx?|xlsx?|pptx?|zip|mp4|mov|mp3|webm|xml|txt|json)$/i, "media"],
  [/\/(wp-content|wp-json|wp-admin|uploads|media|attachment|feed|rss|amp)(\/|$)/i, "media"],
  [/\/(tags?|taggar|etikett|category|categories|kategori(er)?|author|forfattare|skribent|archive|arkiv|topics?)(\/|$)/i, "taxonomy"],
  [/\/page\/\d+\/?$|[?&](page|paged|p)=\d+/i, "pagination"],
  [/\/(t|p|id|node|post)\/\d+\/?$/i, "id"],
  [/\/\d+\/?$/, "id"],
  [/(integritet|personuppgift|cookie|gdpr|privacy|villkor|terms|legal|juridisk-information|disclaimer|ansvarsfriskrivning|tillganglighet|accessibility|sitemap|impressum)/i, "legal"],
  [/\/(kontakt|kontakta-oss|contact|om-oss|about|about-us|karriar|career|careers|jobb|lediga-tjanster|jobs|press|medarbetare|team|personal|kontor|offices?)(\/|$)/i, "company"],
  [/\/(search|sok|cart|kassa|checkout|login|logga-in|my-account|mina-sidor)(\/|$)|[?&]s=/i, "utility"],
];

export function classify(url: string, scopePrefix: string | null = null): { kept: boolean; reason: string | null } {
  const u = new URL(url);
  const path = decodeURIComponent(u.pathname) + u.search;
  const base = scopePrefix ?? "/";
  const rest = u.pathname.slice(base.length).replace(/^\/+|\/+$/g, "");
  if (!rest || /^[a-z]{2}(-[a-z]{2})?$/i.test(rest)) return { kept: false, reason: "home" };
  for (const [re, reason] of nonArticle) if (re.test(path)) return { kept: false, reason };
  return { kept: true, reason: null };
}

export function slugToTopic(url: string): string {
  const segs = new URL(url).pathname.split("/").filter(Boolean);
  let slug = segs.at(-1) ?? "";
  try {
    slug = decodeURIComponent(slug);
  } catch {}
  return slug
    .normalize("NFC")
    .replace(/\.(html?|php|aspx?)$/i, "")
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .replace(/-\d{1,2}$/, "")
    .replace(/[-_+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
