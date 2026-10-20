import { closeDb, db } from "../lib/db.ts";

const ids = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
if (!ids.length) {
  console.error("usage: npm run cluster:pick -- <cluster-id> [<cluster-id> ...]");
  process.exit(1);
}
const sql = db();
const picked = await sql<{ id: number; primary_keyword: string }[]>`
  update heist.clusters set status = 'picked' where id = any(${ids}::bigint[]) and status = 'candidate' returning id::int as id, primary_keyword`;
for (const p of picked) console.log(`picked ${p.id}: ${p.primary_keyword}`);
const missing = ids.filter((id) => !picked.some((p) => p.id === id));
if (missing.length) console.warn(`not candidates (unknown or already picked/skipped): ${missing.join(", ")}`);
await closeDb();
