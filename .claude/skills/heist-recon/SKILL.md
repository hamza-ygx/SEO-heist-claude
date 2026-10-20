---
name: heist-recon
description: Run competitor sitemap recon and enrichment for the SEO heist pipeline, then summarise new topics and DataForSEO spend.
argument-hint: "[competitor-domain | all]"
allowed-tools: Bash(npm run recon *) Bash(npm run recon:ours) Read
---

Run recon for `$ARGUMENTS` (a competitor domain from `heist.sites`, or `all`; default `all`).

1. Run `npm run recon:ours` first so our own coverage is current.
2. Run `npm run recon -- --competitor $0` for a single domain, or `npm run recon -- --all` when the argument is `all` or empty.
3. Read the generated `out/recon_<competitor>_<date>.csv` files.
4. Report per competitor: sitemaps, URLs, kept, new since last run, spend, warnings. Then list the 10 kept topics with the highest traffic (or volume) where `our_position` is empty or > 20.

Rules: never fetch competitor pages beyond robots.txt and sitemaps; never use historical DataForSEO endpoints; stop and report if the monthly DataForSEO budget error appears instead of retrying.
