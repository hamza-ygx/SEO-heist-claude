import postgres from "postgres";
import { env } from "./env.ts";

export type Sql = postgres.Sql;

let client: Sql | null = null;

export function db(): Sql {
  if (client) return client;
  const url = env("DATABASE_URL");
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  client = postgres(url, { max: 3, prepare: false, idle_timeout: 20, ssl: local ? false : "require", onnotice: () => {} });
  return client;
}

export async function closeDb() {
  await client?.end({ timeout: 5 });
  client = null;
}
