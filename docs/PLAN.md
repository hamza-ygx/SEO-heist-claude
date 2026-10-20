# Plan

Stack: TypeScript / Node 22 (`tsx`) · Supabase Postgres (`heist` schema in `rkjh-seo`) · DataForSEO via a stdio MCP · Claude Code only (Max plan; no Anthropic API, no other LLM).

## Files

```
CLAUDE.md                          # how the repo works + the 7 hard rules verbatim
.gitignore                         # .env, node_modules, out/
.env.example                       # placeholders only
.mcp.json                          # clone MCP (stdio, read-only tools)
package.json, tsconfig.json
db/migrations/001_heist.sql        # heist schema, heist_app role, tables, triggers
lib/db.ts                          # postgres client (DATABASE_URL)
lib/fetch.ts                       # port of clone safeFetch + robots parser, 1 req/s per host, honest UA
lib/dfs.ts                         # port of clone dfsBatch (shared api_spend ledger + monthly cap)
mcp/clone-server.ts                # tools: domain_organic_keywords, keyword_gap, keyword_metrics
recon/sitemap.ts                   # robots → sitemaps → index/.gz → filter → slug→topic
recon/enrich.ts                    # per-URL traffic/top kw/volume/KD via MCP-equivalent lib calls
recon/ours.ts                      # our sitemap + GSC/clone positions → coverage set
cluster/export.ts, cluster/import.ts   # batch ≤200 rows to/from the clusterer agent
brief/, drafts/                    # briefs/<slug>.md, drafts/<slug>.md + .qa.json (or DB-only if repo stays public)
qa/checks.ts                       # deterministic checks: lengths, n-gram overlap, JSON-LD parse, dup vs our pages
review/queue.ts, review/approve.ts # queue listing; the only writer of approved_by/approved_at
publish/guard.ts                   # approved + cap check (used by cms.ts AND the hook)
publish/cms.ts                     # WP drafts (Contributor creds) / publish (Editor creds, guard first)
track/gsc.ts                       # reads clone gsc_query_daily (already synced) + serp_ranks
track/report.ts                    # out/report_<YYYY-MM>.md
wp/heist-yoast-meta.php            # mu-plugin for WP admin to install (register_post_meta for Yoast keys)
.claude/agents/{clusterer,strategist,writer,qa}.md
.claude/skills/{heist-recon,heist-brief,heist-draft,heist-review,heist-approve,heist-publish,heist-report}/SKILL.md
.claude/settings.json              # permissions + PreToolUse Bash → guard-publish.sh
.claude/hooks/guard-publish.sh     # fail-closed (exit 2) wrapper around publish/guard.ts
tests/guard-publish.test.sh        # proves an unapproved publish is blocked
docs/RESEARCH.md, docs/PLAN.md
```

## Data model (`heist` schema)

| Table | Key columns |
|---|---|
| `competitors` | `domain` PK, `scope_prefix` (e.g. `/sv-se/`), `active` |
| `sitemap_urls` | (`domain`, `url`) PK, `lastmod`, `first_seen`, `last_seen`, `kept` bool, `drop_reason`, `topic` |
| `topics` | `id`, `domain`, `url`, `topic`, `top_keyword`, `volume`, `kd`, `traffic`, `our_position`, `fetched_at`, `status` (`new`/`kept`/`dropped`), `drop_reason` |
| `clusters` | `id`, `primary_keyword` unique, `intent`, `topic_ids` int[], `est_traffic`, `kd`, `fit`, `gain` (0–5 each), `score`, `ymyl` bool, `status` (`candidate`/`picked`/`skipped`) |
| `articles` | `slug` PK, `cluster_id`, `status` enum `draft→qa_passed→in_review→approved/rejected→scheduled→published`, `brief_path`, `qa` jsonb, `wp_post_id`, `approved_by`, `approved_at`, `scheduled_for`, `published_at`, timestamps |
| `reviewers` | `name` PK, `qualified_ymyl` bool |
| `publish_log` | `id`, `slug`, `action`, `actor`, `wp_post_id`, `result`, `at` |
| `settings` | `weekly_cap` int `CHECK (weekly_cap BETWEEN 1 AND 30)`, default 15 |

DB triggers:
- `status = 'approved'` requires non-null `approved_by` + `approved_at`; `approved_by` must be in `reviewers`, and `qualified_ymyl` if the cluster is YMYL.
- `published` requires prior `approved`; `approved_by`/`approved_at` are immutable once set.

## Phases & checkpoints

| # | Deliverable | Checkpoint (I stop) |
|---|---|---|
| 0 | `docs/RESEARCH.md`, `docs/PLAN.md` | **Now** — approve plan + answer open questions |
| 1 | migration (applied after your OK), lib, MCP, `recon/*`, `.mcp.json`, `out/recon_<competitor>_<date>.csv` | Show recon counts + DFS spend per competitor |
| 2 | `clusterer.md` (haiku), cluster import/export, scoring | **Top 30 clusters table → you pick** |
| 3 | `strategist.md` (opus), `/heist-brief` | Briefs for your picks; `SKIP`s listed |
| 4 | `writer.md` (sonnet), `qa.md` (sonnet), `qa/checks.ts`, `/heist-draft` | **3 topics end-to-end → you review before batching** |
| 5 | `/heist-review`, `/heist-approve` (`disable-model-invocation`), `review/*` | Demo approve flow |
| 6 | `publish/*`, `/heist-publish` (`disable-model-invocation`), hook + test, WP mu-plugin | Hook test output; draft created in WP (needs WP setup) |
| 7 | `track/*`, `/heist-report`, `/schedule` command (recon diff + queue briefs + report; never publishes) | First report |

Phases 1 and 4 are the context-heavy ones; each gets its own session if needed.

## Guard design (rule 3 + 5)

1. `publish/guard.ts` — single source of truth: item `approved`, `approved_by` set by a human, week count < `weekly_cap`, spacing respected. Called by `publish/cms.ts` before any publish/update of a live post (direct runs are guarded too).
2. `.claude/hooks/guard-publish.sh` — `PreToolUse` on `Bash`:
   - Matches publish paths (`publish/cms.ts publish|update-live`, `curl … wp-json … status=publish`, any `wp/v2/posts` write with non-draft status) → runs `guard.ts --slug`; denies on failure.
   - Denies `review/approve.ts` and any SQL touching `approved_by` (only the human-invoked `/heist-approve` skill can run it; it is `disable-model-invocation`).
   - Denies `claude -p` while `ANTHROPIC_API_KEY` is set.
   - Fails closed: any internal error → exit 2.
3. WordPress role split — draft creds are Contributor (cannot publish at all).

## Weekly `/schedule` task (Phase 7, exact command delivered then)

Runs: recon diff → enrich new URLs → queue new candidate clusters → monthly report on the 1st. Never runs `/heist-publish` (also impossible: `disable-model-invocation` skills can't run as scheduled prompts).

## Suggested tests (not written unless you confirm)

sitemap parser (index, .gz, 50k split, dedupe, filters) · slug→topic · robots allow/deny + 1 req/s throttle · DFS budget refusal at cap · n-gram overlap · title/meta length · status-transition triggers · guard cap math across ISO weeks · WP payload builder (draft-only with Contributor creds).
