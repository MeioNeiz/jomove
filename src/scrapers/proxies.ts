/**
 * Free-proxy rotation — emergency fallback for portals that have
 * IP-blocked our server. Fetches public proxy lists, races candidates
 * in parallel through a validator, and returns up to N working proxies
 * along with the body of the first test request (so the caller doesn't
 * have to re-fetch through the same flaky proxy).
 *
 * Free proxies are slow and unreliable by nature; only use when the
 * direct path is hard-blocked. The validator must distinguish real
 * content from WAF/captcha pages because dodgy proxies happily inject
 * their own block screens.
 *
 * A second `sustainUrl` filters out the worst flakes: any candidate
 * that passes the first request but fails a second one is dropped.
 * Doesn't catch every flake but cuts the worst single-shot proxies.
 *
 * Health is persisted to `data/proxy-health.json` so the next run
 * starts from a warm pool of recently-good proxies instead of
 * re-probing public lists from scratch every time. The warm pool is
 * tried before any fresh candidates — a 24h-old "OK" is much more
 * likely to still work than a random row from a public list.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve project root locally instead of importing config.ts — config.ts
// re-exports the scrapers registry, which would create a circular import
// (config → registry → openrent → proxies → config). This file lives at
// src/scrapers/proxies.ts, so root is three dirnames up.
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const PROXY_LIST_URLS = [
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
  "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
  "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=5000",
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const HEADERS = {
  "User-Agent":      UA,
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
};

const HEALTH_PATH    = join(ROOT, "data", "proxy-health.json");
const WARM_MAX_AGE   = 24 * 60 * 60 * 1000;   // 24h since last_ok_at → still warm
const PRUNE_MAX_AGE  =  7 * 24 * 60 * 60 * 1000; // 7d of nothing → drop entry
const WARM_MIN_RATIO = 0;                     // ok_count - fail_count >= 0

let listCache: string[] | null = null;

async function loadProxyList(): Promise<string[]> {
  if (listCache) return listCache;
  const seen = new Set<string>();
  for (const src of PROXY_LIST_URLS) {
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const body = await res.text();
      for (const line of body.split(/\r?\n/)) {
        const t = line.trim();
        if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}$/.test(t)) seen.add(t);
      }
    } catch { /* swallow — try next source */ }
  }
  const out = [...seen];
  // Shuffle so consecutive runs probe different proxies first.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  listCache = out;
  return out;
}

// --- Persistent proxy health -------------------------------------------------

type Health = {
  last_ok_at?:   string;
  last_fail_at?: string;
  ok_count:      number;
  fail_count:    number;
};

let healthCache: Record<string, Health> | null = null;
let healthDirty = false;

function loadHealth(): Record<string, Health> {
  if (healthCache) return healthCache;
  if (!existsSync(HEALTH_PATH)) { healthCache = {}; return healthCache; }
  try {
    healthCache = JSON.parse(readFileSync(HEALTH_PATH, "utf-8")) as Record<string, Health>;
  } catch { healthCache = {}; }
  return healthCache;
}

export function recordProxyOk(proxy: string): void {
  const h = loadHealth();
  const e = h[proxy] ?? { ok_count: 0, fail_count: 0 };
  e.ok_count++;
  e.last_ok_at = new Date().toISOString();
  h[proxy] = e;
  healthDirty = true;
}

export function recordProxyFail(proxy: string): void {
  const h = loadHealth();
  const e = h[proxy] ?? { ok_count: 0, fail_count: 0 };
  e.fail_count++;
  e.last_fail_at = new Date().toISOString();
  h[proxy] = e;
  healthDirty = true;
}

/** Drop entries with no activity in PRUNE_MAX_AGE so the file doesn't grow forever. */
function prune(): void {
  const h = loadHealth();
  const cutoff = Date.now() - PRUNE_MAX_AGE;
  for (const [p, e] of Object.entries(h)) {
    const last = Math.max(
      e.last_ok_at   ? Date.parse(e.last_ok_at)   : 0,
      e.last_fail_at ? Date.parse(e.last_fail_at) : 0,
    );
    if (last < cutoff) { delete h[p]; healthDirty = true; }
  }
}

/** Persist any changes to disk. Safe to call multiple times. */
export function flushProxyHealth(): void {
  if (!healthDirty || !healthCache) return;
  prune();
  mkdirSync(dirname(HEALTH_PATH), { recursive: true });
  writeFileSync(HEALTH_PATH, JSON.stringify(healthCache, null, 2));
  healthDirty = false;
}

/**
 * Warm pool: proxies that succeeded recently. Sorted by most-recently-OK
 * first so the freshest survivors are tried before anything else.
 * Returned shape matches public-list rows (no `http://` prefix) so the
 * existing candidate loop can consume them transparently.
 */
function warmCandidates(): string[] {
  const h = loadHealth();
  const cutoff = Date.now() - WARM_MAX_AGE;
  return Object.entries(h)
    .filter(([_, e]) => {
      if (!e.last_ok_at) return false;
      if (Date.parse(e.last_ok_at) < cutoff) return false;
      return e.ok_count - e.fail_count >= WARM_MIN_RATIO;
    })
    .sort(([, a], [, b]) =>
      Date.parse(b.last_ok_at!) - Date.parse(a.last_ok_at!),
    )
    .map(([p]) => p.replace(/^http:\/\//, ""));
}

// --- Probing ----------------------------------------------------------------

export type ProxyPick = {
  proxy:    string;       // "http://1.2.3.4:8080"
  body:     string;       // body of the first (primary) test fetch
  status:   number;
  finalUrl: string;
};

async function probeOnce(
  proxy:    string,
  url:      string,
  validate: (body: string) => boolean,
  perTryMs: number,
): Promise<{ body: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, {
      proxy,
      headers:  HEADERS,
      redirect: "follow",
      signal:   AbortSignal.timeout(perTryMs),
    });
    if (res.status !== 200) return null;
    const body = await res.text();
    if (!validate(body)) return null;
    return { body, finalUrl: res.url };
  } catch { return null; }
}

export type FindOpts = {
  concurrency?:   number;
  maxCandidates?: number;
  perTryMs?:      number;
  /** Proxies known to be bad — caller passes its blacklist on re-picks. */
  skip?:          Set<string>;
  /** Optional second URL: candidate must pass both to be accepted. */
  sustainUrl?:    string;
};

export async function findWorkingProxies(
  testUrl: string,
  validator: (body: string) => boolean,
  count:   number,
  opts:    FindOpts = {},
): Promise<ProxyPick[]> {
  const skip        = opts.skip ?? new Set<string>();
  const concurrency = opts.concurrency ?? 40;
  const perTryMs    = opts.perTryMs    ?? 8000;
  const sustainUrl  = opts.sustainUrl;

  // Warm pool first (already validated in a past run), then a shuffled
  // slice of fresh public-list candidates. De-dup so warm entries
  // aren't re-probed from the public list.
  const warm  = warmCandidates();
  const fresh = (await loadProxyList()).slice(0, opts.maxCandidates ?? 600);
  const seen  = new Set(warm);
  const ordered: string[] = [...warm];
  for (const c of fresh) if (!seen.has(c)) { seen.add(c); ordered.push(c); }
  if (ordered.length === 0) return [];

  let cursor = 0;
  const results: ProxyPick[] = [];

  const worker = async () => {
    while (results.length < count && cursor < ordered.length) {
      const proxy = `http://${ordered[cursor++]!}`;
      if (skip.has(proxy)) continue;
      const first = await probeOnce(proxy, testUrl, validator, perTryMs);
      if (!first) { recordProxyFail(proxy); continue; }
      if (sustainUrl) {
        const second = await probeOnce(proxy, sustainUrl, validator, perTryMs);
        if (!second) { recordProxyFail(proxy); continue; }
      }
      // Probe success — credit it now, even if we don't keep the body.
      recordProxyOk(proxy);
      if (results.length < count) {
        results.push({ proxy, body: first.body, status: 200, finalUrl: first.finalUrl });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/** Convenience wrapper: returns the first working proxy or null. */
export async function pickWorkingProxy(
  testUrl: string,
  validator: (body: string) => boolean,
  opts:    FindOpts = {},
): Promise<ProxyPick | null> {
  const r = await findWorkingProxies(testUrl, validator, 1, opts);
  return r[0] ?? null;
}

/** Reset cached list — useful for tests or recovering from a stale set. */
export function clearProxyCache(): void { listCache = null; }
