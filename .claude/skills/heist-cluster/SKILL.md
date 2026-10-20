---
name: heist-cluster
description: Filter and cluster recon topics into one-article-per-intent clusters, score them and show the top 30 for the human to pick.
allowed-tools: Bash(npm run cluster:export) Bash(npm run cluster:import) Bash(npm run cluster:top) Read
---

1. Run `npm run cluster:export`. It pre-drops topics with no demand or where rkjh.se already ranks on page 1–2, then writes `out/cluster/batch_<n>.json` (≤200 topics each).
2. For each batch file, delegate to the `clusterer` subagent with the file path (one subagent call per batch; run them in parallel). Each writes `out/cluster/result_<n>.json`.
3. Run `npm run cluster:import`. If it reports a validation error for a result file, re-run the clusterer for that batch once, then import again.
4. Run `npm run cluster:top` and show the table to the user.
5. **Stop.** Ask the user which cluster ids to pick. Do not pick for them. When they answer, run `npm run cluster:pick -- <ids>`.
