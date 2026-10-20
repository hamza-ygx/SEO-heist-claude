import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const cell = (v: unknown) => {
  if (v == null) return "";
  const s = String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function writeCsv(path: string, rows: Record<string, unknown>[], columns: string[]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n") + "\n");
}
