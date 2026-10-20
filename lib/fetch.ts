import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { gunzipSync } from "node:zlib";
import { USER_AGENT } from "./env.ts";

const v4Blocked: [number, number][] = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12],
  [0xc0000000, 24], [0xc0000200, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24],
  [0xe0000000, 4], [0xf0000000, 4],
];

const v4ToInt = (ip: string) => ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;

export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = v4ToInt(ip);
    return !v4Blocked.some(([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits));
  }
  if (isIP(ip) !== 6) return false;
  const a = ip.toLowerCase();
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPublicAddress(mapped[1]);
  if (a.startsWith("::")) return false;
  return !/^(f[cd]|fe[89ab]|ff|2001:db8|64:ff9b|100::)/.test(a);
}

async function assertPublicHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addrs.length || !addrs.every((a) => isPublicAddress(a.address))) throw new Error(`Blocked host ${hostname}`);
}

type Rule = { allow: boolean; path: string };
type Robots = { rules: Rule[]; delayMs: number; sitemaps: string[]; status: number };

export function parseRobots(txt: string, agent = USER_AGENT) {
  const groups: { agents: string[]; rules: Rule[]; delay: number | null }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let inAgents = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === "user-agent") {
      if (!inAgents || !cur) {
        cur = { agents: [], rules: [], delay: null };
        groups.push(cur);
      }
      inAgents = true;
      cur.agents.push(val.toLowerCase());
      continue;
    }
    inAgents = false;
    if (!cur) continue;
    if ((key === "allow" || key === "disallow") && val) cur.rules.push({ allow: key === "allow", path: val });
    if (key === "crawl-delay" && Number.isFinite(Number(val))) cur.delay = Number(val);
  }
  const a = agent.toLowerCase();
  const own = groups.filter((g) => g.agents.some((x) => x !== "*" && a.startsWith(x)));
  const picked = own.length ? own : groups.filter((g) => g.agents.includes("*"));
  const delay = Math.max(0, ...picked.map((g) => g.delay ?? 0));
  return { rules: picked.flatMap((g) => g.rules), delayMs: delay * 1000, sitemaps: [...txt.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]!) };
}

export function robotsAllows(rules: Rule[], path: string) {
  let best: Rule | null = null;
  for (const r of rules) {
    const re = new RegExp("^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (re.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

const MIN_INTERVAL_MS = 1000;
const nextSlot = new Map<string, number>();
const robotsCache = new Map<string, Promise<Robots>>();

async function throttle(host: string, delayMs: number) {
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, at + Math.max(MIN_INTERVAL_MS, delayMs));
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

async function rawGet(u: URL, maxBytes: number): Promise<{ status: number; location?: string; body: Buffer; contentType: string }> {
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Unsupported protocol");
  if (u.port && u.port !== "80" && u.port !== "443") throw new Error("Unsupported port");
  if (u.username || u.password) throw new Error("Credentials in URL");
  await assertPublicHost(u.hostname);
  const res = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { "user-agent": USER_AGENT, accept: "application/xml,text/xml,text/plain;q=0.9,*/*;q=0.5" } });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error(`${u} exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  const location = res.headers.get("location");
  return { status: res.status, location: location ? new URL(location, u).toString() : undefined, body: Buffer.concat(chunks), contentType: res.headers.get("content-type") ?? "" };
}

async function loadRobots(origin: string): Promise<Robots> {
  const host = new URL(origin).host;
  await throttle(host, 0);
  try {
    let u = new URL("/robots.txt", origin);
    for (let i = 0; i < 5; i++) {
      const r = await rawGet(u, 500_000);
      if (r.status >= 300 && r.status < 400 && r.location) {
        u = new URL(r.location);
        continue;
      }
      if (r.status >= 400 && r.status < 500) return { rules: [], delayMs: 0, sitemaps: [], status: r.status };
      if (r.status >= 500) return { rules: [{ allow: false, path: "/" }], delayMs: 0, sitemaps: [], status: r.status };
      return { ...parseRobots(r.body.toString("utf8")), status: r.status };
    }
    return { rules: [{ allow: false, path: "/" }], delayMs: 0, sitemaps: [], status: 0 };
  } catch {
    return { rules: [{ allow: false, path: "/" }], delayMs: 0, sitemaps: [], status: 0 };
  }
}

export function robotsFor(origin: string) {
  const key = new URL(origin).origin;
  if (!robotsCache.has(key)) robotsCache.set(key, loadRobots(key));
  return robotsCache.get(key)!;
}

export class RobotsDenied extends Error {}

export async function politeGet(url: string, { maxBytes = 60_000_000, sameSite }: { maxBytes?: number; sameSite: (host: string) => boolean }) {
  let u = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    if (!sameSite(u.hostname)) throw new Error(`Off-site URL ${u}`);
    const robots = await robotsFor(u.origin);
    if (!robotsAllows(robots.rules, u.pathname + u.search)) throw new RobotsDenied(`robots.txt disallows ${u}`);
    await throttle(u.host, robots.delayMs);
    const r = await rawGet(u, maxBytes);
    if (r.status >= 300 && r.status < 400 && r.location) {
      u = new URL(r.location);
      continue;
    }
    const gz = r.body[0] === 0x1f && r.body[1] === 0x8b;
    const body = gz ? gunzipSync(r.body, { maxOutputLength: 60_000_000 }) : r.body;
    return { url: u.toString(), status: r.status, contentType: r.contentType, text: body.toString("utf8") };
  }
  throw new Error(`Too many redirects for ${url}`);
}
