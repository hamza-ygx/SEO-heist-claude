import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { db } from "../lib/db.ts";
import { keywordGap, keywordMetrics, rankedKeywords, spentThisMonth } from "../lib/dfs.ts";
import { DATABASE, OUR_SITE } from "../lib/env.ts";

const server = new McpServer({ name: "rkjh-clone", version: "0.1.0" });
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const database = z.string().regex(/^[a-z]{2}$/).default(DATABASE).describe("Search database / country, e.g. se");
const domain = z.string().regex(/^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}\/?$/i);

async function respond(run: () => Promise<unknown>) {
  try {
    const sql = db();
    const data = await run();
    const spent = await spentThisMonth(sql);
    return { content: [{ type: "text" as const, text: JSON.stringify({ data, dataforseo_spent_this_month_usd: +spent.toFixed(4) }) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] };
  }
}

server.registerTool(
  "domain_organic_keywords",
  {
    title: "Domain organic keywords",
    description: "Current (not historical) organic keywords a domain ranks for, sorted by estimated traffic. Costs ~$0.005 per call against the shared DataForSEO monthly budget.",
    inputSchema: { domain, limit: z.number().int().min(1).max(1000).default(200), database },
    annotations: readOnly,
  },
  ({ domain, limit, database }) => respond(() => rankedKeywords(db(), domain, limit, database)),
);

server.registerTool(
  "keyword_gap",
  {
    title: "Keyword gap",
    description: `Keywords each competitor ranks for that our site (default ${OUR_SITE}) does not. One DataForSEO call per competitor.`,
    inputSchema: { competitors: z.array(domain).min(1).max(4), ours: domain.default(OUR_SITE), limit: z.number().int().min(1).max(1000).default(300), database },
    annotations: readOnly,
  },
  ({ competitors, ours, limit, database }) =>
    respond(async () => {
      const out = [];
      for (const c of competitors) out.push(...(await keywordGap(db(), ours, c, limit, database)));
      return out;
    }),
);

server.registerTool(
  "keyword_metrics",
  {
    title: "Keyword metrics",
    description: "Search volume, keyword difficulty, CPC, intent and 12-month trend. Served from the clone's 7-day cache first; only misses hit DataForSEO.",
    inputSchema: { keywords: z.array(z.string().min(1).max(80)).min(1).max(700), database, cache_only: z.boolean().default(false) },
    annotations: readOnly,
  },
  ({ keywords, database, cache_only }) => respond(async () => Object.fromEntries(await keywordMetrics(db(), keywords, database, !cache_only))),
);

await server.connect(new StdioServerTransport());
