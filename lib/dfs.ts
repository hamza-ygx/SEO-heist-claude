import type { Sql } from "./db.ts";
import { DATABASE, optEnv } from "./env.ts";

const API = "https://api.dataforseo.com/v3";
const reserveUsd = 0.15;
export const ttlDays = 7;
export const BY = "heist";

export class DfsBudgetError extends Error {}

const locations: Record<string, [number, string]> = { se: [2752, "sv"], dk: [2208, "da"], no: [2578, "nb"], fi: [2246, "fi"], uk: [2826, "en"], us: [2840, "en"] };
export const geo = (database = DATABASE) => {
  const [location_code, language_code] = locations[database] ?? locations.se!;
  return { location_code, language_code };
};

const monthlyLimit = () => Math.max(0, Number(optEnv("DATAFORSEO_MONTHLY_LIMIT_USD", "20")) || 0);

function auth() {
  const login = optEnv("DATAFORSEO_LOGIN");
  const password = optEnv("DATAFORSEO_PASSWORD");
  if (!login || !password) throw new Error("DataForSEO is not configured (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD)");
  return `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
}

type Task = { status_code?: number; status_message?: string; cost?: number; result?: Record<string, unknown>[] | null };
type Body = { status_code?: number; status_message?: string; cost?: number; tasks?: Task[] };

export async function spentThisMonth(db: Sql) {
  const [r] = await db<{ spent: number }[]>`select coalesce(sum(cost), 0)::float8 as spent from public.api_spend where provider = 'dataforseo' and at >= date_trunc('month', now())`;
  return r?.spent ?? 0;
}

export async function dfsPost(db: Sql, endpoint: string, task: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const authHeader = auth();
  const limit = monthlyLimit();
  const reserved = await db.begin(async (tx) => {
    await tx`set local lock_timeout = '5s'`;
    await tx`set local statement_timeout = '10s'`;
    await tx`select pg_advisory_xact_lock(hashtext('dataforseo_spend'))`;
    const [r] = await tx<{ spent: number }[]>`select coalesce(sum(cost), 0)::float8 as spent from public.api_spend where provider = 'dataforseo' and at >= date_trunc('month', now())`;
    if ((r?.spent ?? 0) + reserveUsd > limit) return null;
    const [row] = await tx<{ id: number }[]>`insert into public.api_spend (provider, endpoint, cost, by) values ('dataforseo', ${endpoint}, ${reserveUsd}, ${BY}) returning id`;
    return row!.id;
  });
  if (reserved == null) throw new DfsBudgetError(`DataForSEO monthly limit of $${limit} reached`);
  let cost = 0;
  let body: Body;
  try {
    const res = await fetch(`${API}/${endpoint}`, { method: "POST", headers: { Authorization: authHeader, "Content-Type": "application/json" }, body: JSON.stringify([task]), signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`DataForSEO ${endpoint}: HTTP ${res.status}`);
    body = (await res.json()) as Body;
    cost = Number(body.cost ?? body.tasks?.reduce((s, t) => s + (t.cost ?? 0), 0) ?? 0) || 0;
  } finally {
    await db`update public.api_spend set cost = ${cost} where id = ${reserved}`;
  }
  const t = body.tasks?.[0];
  if (body.status_code !== 20000 || !t || t.status_code !== 20000) throw new Error(`DataForSEO ${endpoint}: ${t?.status_code ?? body.status_code} ${t?.status_message ?? body.status_message ?? "failed"}`);
  return t.result ?? [];
}

type Obj = Record<string, unknown>;
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r0 = (v: unknown) => (n(v) == null ? null : Math.round(v as number));
const items = (result: Obj[]) => (result[0]?.items as Obj[] | undefined) ?? [];
const o = (v: unknown) => (v && typeof v === "object" ? (v as Obj) : {});

export const normKeyword = (k: string) => k.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
export const bareDomain = (d: string) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");

export type KeywordMetric = { keyword: string; volume: number | null; kd: number | null; cpc: number | null; competition: number | null; trends: number[]; intent: string | null; updated: string | null };

function trendsOf(ki: Obj) {
  const monthly = ((ki.monthly_searches as { year?: number; month?: number; search_volume?: number }[] | undefined) ?? [])
    .slice()
    .sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || (a.month ?? 0) - (b.month ?? 0))
    .slice(-12)
    .map((m) => m.search_volume ?? 0);
  const peak = Math.max(1, ...monthly);
  return monthly.map((v) => +(v / peak).toFixed(2));
}

function metricOf(keyword: unknown, ki: Obj, kp: Obj, si: Obj): KeywordMetric {
  return {
    keyword: String(keyword ?? ""),
    volume: r0(ki.search_volume),
    kd: n(kp.keyword_difficulty),
    cpc: n(ki.cpc),
    competition: n(ki.competition),
    trends: trendsOf(ki),
    intent: typeof si.main_intent === "string" ? si.main_intent : null,
    updated: typeof ki.last_updated_time === "string" ? ki.last_updated_time : null,
  };
}

export type RankedKeyword = KeywordMetric & { position: number | null; url: string; etv: number | null };

export async function rankedKeywords(db: Sql, domain: string, limit = 1000, database = DATABASE): Promise<RankedKeyword[]> {
  const result = await dfsPost(db, "dataforseo_labs/google/ranked_keywords/live", {
    target: bareDomain(domain),
    ...geo(database),
    item_types: ["organic"],
    limit: Math.min(1000, Math.max(1, limit)),
    order_by: ["ranked_serp_element.serp_item.etv,desc"],
  });
  return items(result)
    .map((it) => {
      const kd = o(it.keyword_data);
      const serp = o(o(it.ranked_serp_element).serp_item);
      return { ...metricOf(kd.keyword, o(kd.keyword_info), o(kd.keyword_properties), o(kd.search_intent_info)), position: r0(serp.rank_group ?? serp.rank_absolute), url: String(serp.url ?? ""), etv: n(serp.etv) };
    })
    .filter((k) => k.keyword);
}

export type PageMetric = { url: string; keywords: number | null; etv: number | null };

export async function relevantPages(db: Sql, domain: string, limit = 1000, database = DATABASE): Promise<PageMetric[]> {
  const result = await dfsPost(db, "dataforseo_labs/google/relevant_pages/live", { target: bareDomain(domain), ...geo(database), limit: Math.min(1000, Math.max(1, limit)) });
  return items(result)
    .map((it) => {
      const organic = o(o(it.metrics).organic);
      return { url: String(it.page_address ?? ""), keywords: r0(organic.count), etv: n(organic.etv) };
    })
    .filter((p) => p.url);
}

export type GapKeyword = KeywordMetric & { competitor: string; position: number | null; url: string; etv: number | null };

export async function keywordGap(db: Sql, ours: string, competitor: string, limit = 500, database = DATABASE): Promise<GapKeyword[]> {
  const result = await dfsPost(db, "dataforseo_labs/google/domain_intersection/live", {
    target1: bareDomain(competitor),
    target2: bareDomain(ours),
    intersections: false,
    ...geo(database),
    item_types: ["organic"],
    limit: Math.min(1000, Math.max(1, limit)),
    order_by: ["keyword_data.keyword_info.search_volume,desc"],
  });
  return items(result)
    .map((it) => {
      const kd = o(it.keyword_data);
      const serp = o(it.first_domain_serp_element);
      return { ...metricOf(kd.keyword, o(kd.keyword_info), o(kd.keyword_properties), o(kd.search_intent_info)), competitor: bareDomain(competitor), position: r0(serp.rank_group ?? serp.rank_absolute), url: String(serp.url ?? ""), etv: n(serp.etv) };
    })
    .filter((k) => k.keyword);
}

export async function keywordMetrics(db: Sql, keywords: string[], database = DATABASE, fetchMissing = true): Promise<Map<string, KeywordMetric>> {
  const out = new Map<string, KeywordMetric>();
  const list = [...new Set(keywords.map(normKeyword).filter((k) => k && k.length <= 80 && k.split(" ").length <= 10))];
  if (!list.length) return out;
  const cached = await db<{ keyword: string; data: KeywordMetric | null }[]>`
    select keyword, data from public.dfs_keywords where database = ${database} and keyword = any(${list}::text[]) and fetched_at > now() - make_interval(days => ${ttlDays})`;
  for (const c of cached) if (c.data) out.set(c.keyword, c.data);
  const seen = new Set(cached.map((c) => c.keyword));
  const missing = list.filter((k) => !seen.has(k));
  if (!missing.length || !fetchMissing) return out;
  for (let i = 0; i < missing.length; i += 700) {
    const chunk = missing.slice(i, i + 700);
    const result = await dfsPost(db, "dataforseo_labs/google/keyword_overview/live", { keywords: chunk, ...geo(database) });
    const byKw = new Map(items(result).map((it) => [normKeyword(String(it.keyword ?? "")), metricOf(it.keyword, o(it.keyword_info), o(it.keyword_properties), o(it.search_intent_info))]));
    for (const k of chunk) {
      const m = byKw.get(k) ?? null;
      await db`insert into public.dfs_keywords (keyword, database, data) values (${k}, ${database}, ${m ? db.json(m as never) : null})
        on conflict (keyword, database) do update set data = excluded.data, fetched_at = now()`;
      if (m) out.set(k, m);
    }
  }
  return out;
}
