# Phase 0 — Research

Date: 2026-10-20 · Scope: internal site (RKJH) · Status: **awaiting approval**

## Config (confirmed with Hamza)

| Field | Value |
|---|---|
| OUR_SITE | https://rkjh.se (Semrush/clone project is `www.rkjh.se`) |
| COMPETITORS | **Open** — to be picked from the shortlist in §6 |
| CMS | WordPress + Yoast SEO (unverified, see §2) |
| CONTENT_LANG | Swedish |
| SEMRUSH_CLONE | Live: `charinrps-ai/rkjh-seo` (see §1) |
| AUDIENCE | Internal |
| Runtime / DB | Claude Code cloud sessions + Supabase Postgres |
| Min volume | 50 / month (SE) |
| Business fit | Revision, redovisning/bokslut, skatt/deklaration, bolagsrätt/starta bolag |
| YMYL | Allowed: an auktoriserad revisor is the named author |
| Publish guard | Inside `publish/cms` **and** a `PreToolUse` hook |
| Git | Commit and push to `claude/new-session-ykj773` after each phase |

## 1. The Semrush clone

**There are two repos, and the one you named is stale.**

| | `hamza-ygx/Semrush` | `charinrps-ai/rkjh-seo` |
|---|---|---|
| Last push | 2026-10-10 | 2026-10-19 (branches `main`, `seo-priority-1`) |
| Data sources | Semrush API (optional) + imported snapshot | **DataForSEO** + Semrush API + GSC + GA4 + Bing + PSI |
| Matches the live DB? | No | Yes: the `dfs_*`, `serp_*`, `api_spend` tables only exist here |

Treat `charinrps-ai/rkjh-seo` as SEMRUSH_CLONE. It's a Next.js 16 / TypeScript app on Vercel, backed by the Supabase project **`rkjh-seo`** (`wjwhkgjjcnswbgkwjkmu`, eu-north-1, Postgres 17).

### What it exposes

- **No public REST API and no CLI.** Data is fetched in Next.js server actions behind a staff session (`@rkjh.se` login). External callers can't reach it.
- **No MCP server.**
- **A DB we can reuse.** `semrush_data` (jsonb snapshots), `dfs_keywords`, `dfs_cache`, `dfs_serp`, `serp_ranks`, `tracked_keywords`, `gsc_query_daily` (14k rows), `crawl_pages`, plus the `api_spend` ledger.

So the MCP has to sit on **DataForSEO + the Supabase DB directly**, re-using the clone's spend ledger rather than its HTTP layer.

### Where the data comes from

**It does not scrape Google.** It uses DataForSEO (`api.dataforseo.com/v3`, a paid SERP and keyword provider) and, optionally, the official Semrush API. The `google.com/search?q=` strings in the code are only outbound links in the UI.

There's a budget guard. `dfsBatch()` reserves $0.15 per call in `api_spend` inside a transaction, refuses to run past `DATAFORSEO_MONTHLY_LIMIT_USD` (default **$20/month**), then writes back the real cost. There's also a 7-day cache (`dfsTtlDays`). Our MCP should write to the same ledger so the pipeline and the clone share one budget.

### Cost per lookup

These are observed costs from `api_spend` on 2026-10-19/20, average USD per call:

| Need | DataForSEO endpoint | Avg $/call |
|---|---|---|
| Organic keywords per domain | `dataforseo_labs/google/ranked_keywords/live` | 0.0045 |
| Traffic and keywords per competitor URL | `dataforseo_labs/google/relevant_pages/live` | 0.0035 |
| Volume, KD, intent per keyword | `dataforseo_labs/google/keyword_overview/live` | 0.0122 |
| Competitor discovery | `dataforseo_labs/google/competitors_domain/live` | 0.0036 |
| Live SERP (top 3 for information gain) | `serp/google/organic/live/advanced` | 0.0200 |
| Keyword gap | `dataforseo_labs/google/domain_intersection/live` | not used by the clone yet; similar Labs pricing expected |
| *Historical* (avoid) | `historical_rank_overview/live` | 0.0318 (≈4× `domain_rank_overview` at 0.0076) |

Estimate for one competitor (relevant_pages + ranked_keywords + keyword_overview batches): **≈ $0.10–0.40**. The $20/month cap is enough for weekly diffs on 3 competitors. We use current data only, never historical.

There's also the Semrush API route via the clone's `semrushApi.ts`. Its UI warns that one sync costs 20–30k API units. Don't use it in the pipeline.

### Note on the clone's LLM use

The clone calls `api.anthropic.com` (`src/lib/ai/claude.ts`) for its own content features. The pipeline must **never** call those features. It must also never inherit `ANTHROPIC_API_KEY`, because headless `claude -p` *always* prefers the API key when it's set, which would bill the API instead of the Max plan (see §4).

### MCP plan (Phase 1)

A thin stdio server in this repo, `mcp/clone-server.ts`, with read-only tools:

- `domain_organic_keywords(domain, limit)` → `ranked_keywords`
- `keyword_gap(ours, competitors[], limit)` → `domain_intersection` (`intersections: false` for "they rank, we don't")
- `keyword_metrics(keywords[])` → `keyword_overview`, checked against the cache (`dfs_keywords`, 7-day TTL) first

Each call goes through a port of `dfsBatch` (reserve → call → settle in `api_spend`, `by = 'heist-mcp'`). "Read-only" here means no writes to the clone's business tables. Writing to the spend ledger is the one intended exception.

## 2. CMS: WordPress + Yoast

**I couldn't verify this live.** This cloud environment's network policy blocks `rkjh.se` (the proxy returns 403 on CONNECT). Everything below is from documentation and needs a live check once the host is allowed.

- **Drafts.** `POST /wp-json/wp/v2/posts` with `status: "draft"`, `slug`, `excerpt`, `categories`, `content`, authenticated with an Application Password over HTTPS (WP ≥ 5.6).
- **Least privilege, enforced by WordPress itself:**
  - The draft account is a **Contributor**. Contributors can create and edit their own drafts and *cannot publish*, so even a bug can't make anything live.
  - The publish account is a separate **Editor** credential. Only `publish/cms` reads it, and only after the DB guard passes.
  - Contributors can't upload media. Featured images either need the Editor account or are set by hand. **Open question.**
- **Yoast meta isn't writable over REST by default.** Yoast exposes a read-only `yoast_head_json`. To write the fields we need a ~20-line mu-plugin that calls `register_post_meta('post', …, ['show_in_rest' => true, 'single' => true, 'type' => 'string', 'auth_callback' => fn() => current_user_can('edit_posts')])` for:
  - `_yoast_wpseo_title`
  - `_yoast_wpseo_metadesc`
  - `_yoast_wpseo_focuskw`
  - optionally `_yoast_wpseo_canonical`

  We then write them via the `meta` object on the post. WordPress.org plugins exist that do this (*SEO Fields API Support*, *42flows SEO Meta*), but our own mu-plugin is smaller and auditable. **Someone with WP admin has to install it.**
- **JSON-LD.** Yoast already outputs a schema graph with `Article`, `WebPage` and `BreadcrumbList`. Injecting our own Article and BreadcrumbList would **duplicate** them, so the plan changes:
  - Let Yoast own Article and BreadcrumbList, and set author, headline and dates through the post itself.
  - Extend the graph only through the `wpseo_schema_graph` filter in the same mu-plugin, if we ever need more.
- **FAQPage is dropped.** Google stopped showing FAQ rich results for all sites on 2026-05-07 and removed tooling support in June and August 2026. The markup is harmless but brings nothing in Google, so it isn't worth the QA cost.
- **The site is multilingual** (`/en/`, `/zh/` paths), so it's probably WPML or Polylang. Drafts must be created in the Swedish language context. **Open question:** which plugin?

## 3. Our site: existing coverage

I couldn't fetch the sitemap (the host is blocked). As a stand-in I used the clone's Semrush snapshot (2026-09-30) and `crawl_pages` (505 rows):

- rkjh.se has **132 organic keywords, ≈59 visits/month**, and 45 ranking URLs.
- On-topic content exists for: starta eget, bilda/köpa AB, hobby vs företag, bilförmån, personalvårdsförmåner, direktpension, företagsvärdering, läsa bokslut, outsourcing, revision, skatterådgivning, affärsjuridik, plus branch pages (fastighet, hantverkare, lantbruk).
- There's **off-topic legacy content**: glasblåsning, kost, matbudget, "hot och utpressning", hantlangare, cancerfonden, klimat. It doesn't affect the heist directly, but it dilutes topical focus. I suggest a separate cleanup decision; I won't act on it.
- Phase 1 replaces this stand-in with the real sitemap once `rkjh.se` is allowed.

## 4. Claude Code mechanics (verified 2026-10-20 against code.claude.com/docs)

- **Subagents** (`.claude/agents/*.md`): required `name` and `description`; `model` accepts `opus`, `sonnet`, `haiku`, `fable`, `inherit` or a full ID; `tools` is an allowlist.
  - Subagents *can* spawn subagents by default. We omit `Agent` from `tools` on all four agents to stop that.
  - [docs/sub-agents](https://code.claude.com/docs/en/sub-agents)
- **Skills** (`.claude/skills/<name>/SKILL.md`):
  - `disable-model-invocation: true` hides the skill from Claude, so only a human typing `/name` runs it. It also **can't be used as a scheduled-task prompt**, which is exactly what we want for `heist-publish` and `heist-approve`.
  - Arguments are **zero-indexed**: `$0` = first and `$1` = second. `$ARGUMENTS` holds all of them.
  - `allowed-tools` pre-approves tools; it doesn't restrict them.
  - [docs/skills](https://code.claude.com/docs/en/skills)
- **`PreToolUse` hooks**:
  - Shape: `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-publish.sh"}]}]}}`.
  - Stdin is JSON with `tool_input.command`. **Exit 2 blocks**, and stderr becomes the reason. Any other non-zero exit is *non-blocking*, so the guard must fail closed with exit 2 on its own errors, such as DB unreachable.
  - [docs/hooks](https://code.claude.com/docs/en/hooks)
- **Headless `claude -p`**: flags `--output-format json`, `--allowedTools`, `--permission-mode`, `--max-turns`, `--append-system-prompt`, `--max-budget-usd`.
  - It uses the Max-plan OAuth login **unless `ANTHROPIC_API_KEY` is set, which always wins**.
  - Mitigation: `.env.example` has no such key, the guard hook refuses to run `claude -p` while the variable is set, and `CLAUDE.md` states the rule.
  - [docs/headless](https://code.claude.com/docs/en/headless), [docs/authentication](https://code.claude.com/docs/en/authentication)
- **`/schedule`**: creates a cloud scheduled task (formerly called a "routine").
  - Runs as a Claude Code cloud session with a fresh clone of the repo, needs a subscription login, and has a minimum interval of 1 h.
  - Secrets go into the environment as network secrets or env vars. Hosts must be on the environment's network allowlist.
  - [docs/routines](https://code.claude.com/docs/en/routines)
- **`.mcp.json`**: `{"mcpServers":{"clone":{"type":"stdio","command":"npx","args":["tsx","mcp/clone-server.ts"],"env":{…}}}}`. `${VAR}` and `${VAR:-default}` expansion works in `command`, `args` and `env`.
  - [docs/mcp](https://code.claude.com/docs/en/mcp)

## 5. Google context (verified against secondary sources)

- **2026-10-01:** Google's generative-AI content guidance now calls manual fact-checking "critical" and explicitly covers titles, meta descriptions, structured data and alt text. No new penalty was announced; it ties into the scaled-content-abuse policy. Sources: [SEJ](https://www.searchenginejournal.com/google-fact-check-ai-content-before-publishing/591782/), [HigherVisibility](https://www.highervisibility.com/seo/learn/googles-ai-content-guide-now-calls-manual-fact-checking-critical/).
- **Spam updates:**
  - **June 2026** (≈Jun 24–26): content-level, explicitly not targeting link spam or site reputation abuse.
  - **August 2026** (≈Aug 18–21): scaled content abuse.
  - **September 2026** (from Sep 24; end date reported differently).
  - Sources: [PPC Land](https://ppc.land/scaled-content-abuse/), [Clique](https://cliquestudios.com/university/resources/google-june-2026-spam-update), [SaaSCity](https://saascity.io/blog/google-august-2026-spam-update).
- **FAQ rich results retired 2026-05-07.** Source: [TechWyse](https://www.techwyse.com/news/ai-search/google-faq-rich-results-deprecated-2026).

Caveat: these are trade-press summaries. Check Google's Search Status Dashboard before quoting dates externally.

**Implication for a site with ≈59 visits/month:** 15 posts/week would be a huge jump in content velocity on a small domain, which is exactly the pattern the 2026 updates penalise. Rule 5's cap of 15 still applies, but I recommend **starting at 3–5/week** for the first 8 weeks and raising it only if GSC shows the pages being indexed and earning impressions.

## 6. Competitors: the obvious ones are too small

The clone's top-3 organic competitors (by keyword overlap) are local Halmstad firms:

| Domain | Organic kw | Traffic/mo |
|---|---|---|
| ellox.se | 16 | 47 |
| jbekonomi.com | 31 | 386 |
| ek3hjartan.se | 15 | 35 |

Mining their sitemaps would give a handful of service pages, not article topics. The existing keyword gap against them (137 rows) is mostly *our* keywords. Better mining targets, meaning same-niche accounting firms with real content, all from the same competitor report:

| Domain | Organic kw | Traffic/mo | Why |
|---|---|---|---|
| **cedra.se** | 575 | 733 | Highest relevance (0.07) of the content-heavy firms |
| **bakertillyhalmstad.se** | 647 | 1,197 | Same city, same services, has content |
| **azets.com** (only `/sv-se/` paths) | 3,456 | 6,599 | National-scale accounting content; high KD, mine for long-tail |
| metricaccounting.se | 800 | 1,051 | Accounting-firm blog |
| revisorportalen.se | 915 | 203 | Revisor-focused content |

My recommendation is **cedra.se + bakertillyhalmstad.se + azets.com (sv-se)**. I'd avoid SaaS publishers (Fortnox, Bokio, Visma). Their KD is out of reach for a domain this size.

## 7. Stack

**TypeScript on Node 22 (`tsx`), with `postgres` (porsager), `fast-xml-parser`, `@modelcontextprotocol/sdk` and `zod`.**

The clone is TypeScript and uses the same `postgres` client against the same Supabase DB. That lets us port its tested pieces nearly verbatim:

- `dfsBatch` budget ledger
- `safeFetch` with SSRF guard and byte cap
- the robots.txt parser in `crawler.ts`

The MCP TypeScript SDK is the reference implementation. Python would mean re-implementing the budget guard and robots handling and running two toolchains against one DB, for no gain.

The prompt's file names change accordingly: `recon/sitemap.ts`, `publish/cms.ts`, `track/gsc.ts`.

**DB:** a new **`heist` schema** in the `rkjh-seo` Supabase project, accessed by a dedicated `heist_app` role. It gets:

- full rights on `heist.*`
- `SELECT` on the `public` tables we need
- `INSERT/UPDATE` on `public.api_spend` only

That way a pipeline bug can't touch the clone's data. RLS stays on, with the app connecting as an owner/role (same pattern the clone uses).

## 8. Risks

1. **Network policy blocks the target hosts** (rkjh.se, competitors, probably api.dataforseo.com and the Supabase pooler). Phase 1 can't run in cloud sessions until they're allowlisted. The same allowlist is needed for the weekly `/schedule` task.
2. **Shared production DB.** The migration creates a new schema and role in the live `rkjh-seo` project. It's additive only, but I'll ask before applying.
3. **The repo is public.** `hamza-ygx/SEO-heist-claude` is public. Briefs carry `NEEDS_INPUT` first-hand material (client cases, internal numbers), and drafts sit there before review. **Recommend making it private** before Phase 3; otherwise briefs and drafts must live only in the DB.
4. **Approval spoofing.** A hook can't tell whether a human typed `/heist-approve` or the model called the underlying script. Mitigations:
   - `disable-model-invocation: true` on the skill
   - the hook blocks any Bash command that references `approved_by`/`approve` outside the skill's exact script
   - a DB trigger rejects `approved` status without `approved_by` and `approved_at`

   **The strongest option** is an approve button in the clone's web UI, where the staff login supplies `approved_by`. Proposed as an optional Phase 5 extra.
5. **YMYL.** Tax and finance articles need the named revisor's review, not just *a* human. `approved_by` must be on an allowlist of qualified reviewers for clusters flagged `ymyl = true`.
6. **Small-domain velocity** (§5): start at 3–5/week.
7. **Yoast and multilingual plugin behaviour** is unverified until the site is reachable.

## 9. GDPR (internal site; light touch)

- **GSC data** is aggregated query/page data, not personal data. It's already stored by the clone in the EU (eu-north-1).
- **The author name and bio** of the named revisor are published personal data. Get written consent for the byline and bio, and keep it with the approval record.
- **Reviewer names** in `approved_by` are internal personal data. They're kept for accountability; no retention issue.
- **Competitor data** is URLs and slugs only. No personal data is collected.

## 10. Open questions (blocking where marked)

1. **(Blocking Phase 1)** Allow these hosts in the environment's network settings:
   - `rkjh.se`, `www.rkjh.se`
   - the chosen competitor domains
   - `api.dataforseo.com`
   - the Supabase pooler host (`aws-0-eu-north-1.pooler.supabase.com` or your project's)
   - `searchconsole.googleapis.com`, `oauth2.googleapis.com`
2. **(Blocking Phase 1)** Pick the competitors (§6).
3. **(Blocking Phase 6)** WP admin: install the Yoast-meta mu-plugin and create the two WP users (Contributor for drafts, Editor for publish). Which multilingual plugin is in use?
4. Make the repo private? (§8.3)
5. Starting weekly cap of 3–5 instead of 15? (§5)
6. Who is the named revisor author, and who else may approve?
