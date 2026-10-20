# SEO heist pipeline (rkjh.se)

Finds topics competitors rank for and rkjh.se doesn't, then produces better, original Swedish articles, each approved by a human before it goes live. The only AI is Claude, run through Claude Code on the Max plan. Never use the Anthropic API, Codex or any other LLM.

See `docs/RESEARCH.md` (findings, risks) and `docs/PLAN.md` (files, data model, phases).

## Hard rules (these apply to every phase)

1. **Take only URLs and titles from competitors.** Never fetch, store or paraphrase a competitor's body text. Their sitemap tells us *what* to write about. *What we say* comes from our own research, data and experience.
2. **Crawl politely.** Read robots.txt first and respect it, send one request per second at most, use an honest User-Agent, and use no proxies or evasion tricks.
3. **Nothing goes live without human approval.** The pipeline may create CMS **drafts** only. Publishing requires an `approved_by` value set by a person, and a hook enforces this (see Phase 6).
4. **Fact-check everything that can appear in Google.** That means the body, title tag, meta description, structured data and image alt text. Google added this to its AI-content guidance on 2026-10-01. Unverified claims get flagged for the reviewer, never published silently.
5. **Publish slowly.** The default cap is 15 posts a week (configurable, hard max 30). Google's spam updates in June, August and September 2026 targeted scaled, low-value AI pages, and the hits spread to the whole domain.
6. **Keep secrets out of git.** CMS credentials, GSC keys and clone API keys go in `.env`, which is gitignored, and in `.env.example` with placeholders. Never log or print them.
7. **Ask before anything destructive.** That includes deleting, overwriting existing CMS posts, unpublishing, `git push` and deploying.

## Project decisions on top of the rules

- Competitor titles come from the URL slug only; competitor pages are never fetched (not even for `<title>`).
- Weekly cap starts at **3** (`heist.settings.weekly_cap`) until `cap_review_after`; raising it is a human decision.
- `ANTHROPIC_API_KEY` must never be set in this repo's environment: `claude -p` would bill the API instead of the Max plan.
- Claude never sets `approved_by`/`approved_at`. The DB enforces it: role `heist_app` (used by every script) has no UPDATE on those columns; only `heist.approve()` via the reviewer's `heist_approver` credential can set them.
- YMYL clusters (tax, finance) need a reviewer with `qualified_ymyl` (the auktoriserad revisor).
- Yoast owns Article/BreadcrumbList JSON-LD; no FAQPage (Google retired FAQ rich results 2026-05-07).

## How it works

- Stack: TypeScript on Node 22 (`tsx`), Supabase Postgres schema `heist` in project `rkjh-seo`, DataForSEO for keyword data (shared monthly budget in `public.api_spend`).
- `npm run recon -- --competitor <domain>` / `--all`: sitemaps → `heist.sitemap_urls` → enrich → `heist.topics` + `out/recon_<competitor>_<date>.csv`.
- `npm run recon:ours`: our own sitemap for cannibalisation checks.
- MCP `rkjh-clone` (`.mcp.json`): read-only `domain_organic_keywords`, `keyword_gap`, `keyword_metrics`.
- `npm run typecheck` before committing.
- Status flow: `draft → qa_passed → in_review → approved | rejected → scheduled → published` (enforced by trigger `heist.articles_guard`).
