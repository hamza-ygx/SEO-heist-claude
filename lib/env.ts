import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export function env(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

export const optEnv = (name: string, fallback = "") => process.env[name]?.trim() || fallback;

export const OUR_SITE = optEnv("OUR_SITE", "rkjh.se");
export const DATABASE = optEnv("SEARCH_DATABASE", "se");
export const USER_AGENT = optEnv("CRAWLER_USER_AGENT", "RKJH-HeistRecon/0.1 (+https://www.rkjh.se)");
