/**
 * HTTP wrapper shared across portal scrapers.
 *
 * - Realistic Chrome desktop UA + en-GB locale.
 * - Per-host token-bucket rate limit so two scrapers can't accidentally
 *   bang the same portal in parallel via shared infra.
 * - Retry on 429/5xx with jittered exponential backoff. 403 is NOT
 *   retried — most portals serve 403 as a soft-block, retrying just
 *   digs deeper.
 * - Cookie jar per scraper instance so session cookies (e.g. Gumtree's
 *   `gt_p`/`gt_s`) persist across requests.
 */

import { logFetch, logFetchError } from "./log.ts";

// Full 4-part Chrome version, not the bare "131.0.0.0" placeholder every
// scraping tutorial copies verbatim — Rightmove's Akamai WAF blocklists
// that exact literal UA string regardless of TLS/HTTP client.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.6778.85 Safari/537.36";

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":      UA,
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
};

export type FetchOpts = {
  headers?:   Record<string, string>;
  referer?:   string;
  timeoutMs?: number;
  retries?:   number;
  /** Route through an HTTP(S) proxy, e.g. "http://1.2.3.4:8080". */
  proxy?:     string;
  /**
   * Extra status codes that should trigger a retry. Defaults to the
   * built-in 429 + 5xx set; useful for proxy-rotation scenarios where
   * a soft block (e.g. WAF 405) on one rotated IP may succeed on the
   * next attempt's freshly-rotated IP.
   */
  retryOnStatuses?: number[];
  /**
   * Base backoff for retries in ms. Default 800 (exponential). When
   * set, uses linear backoff at this value — appropriate for fast
   * proxy-rotation retries where exp backoff would balloon the run.
   */
  retryBackoffMs?: number;
};

type HostState = { lastAt: number; cookies: Map<string, string> };
const HOSTS = new Map<string, HostState>();

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function jitter(baseMs: number): number {
  return baseMs + Math.floor(Math.random() * baseMs);
}

function getState(host: string): HostState {
  let s = HOSTS.get(host);
  if (!s) { s = { lastAt: 0, cookies: new Map() }; HOSTS.set(host, s); }
  return s;
}

/** Minimum gap between requests to the same host, in ms. */
export function setHostRateLimit(host: string, _minGapMs: number): void {
  // Stored on the state via lastAt + checked at call time. The gap is
  // currently a function arg to `fetchText`; this stub keeps a hook for
  // future per-host tuning without changing call sites.
  void host;
}

function parseSetCookie(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const part of raw.split(/,(?=[^;]+=)/)) {
    const eq = part.indexOf("=");
    const semi = part.indexOf(";");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = (semi > eq ? part.slice(eq + 1, semi) : part.slice(eq + 1)).trim();
    if (name) out.push([name, value]);
  }
  return out;
}

function cookieHeader(host: string): string {
  const s = HOSTS.get(host);
  if (!s || s.cookies.size === 0) return "";
  return [...s.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

export async function fetchText(
  url: string,
  opts: FetchOpts & { minGapMs?: number } = {},
): Promise<{ status: number; url: string; body: string }> {
  const host = hostOf(url);
  const state = getState(host);

  const minGap = opts.minGapMs ?? 1500;
  const since = Date.now() - state.lastAt;
  if (since < minGap) {
    await new Promise(r => setTimeout(r, minGap - since));
  }

  const headers: Record<string, string> = { ...DEFAULT_HEADERS, ...(opts.headers ?? {}) };
  if (opts.referer) headers["Referer"] = opts.referer;
  const cookies = cookieHeader(host);
  if (cookies) headers["Cookie"] = cookies;

  const retries     = opts.retries ?? 2;
  const extraStatuses = new Set(opts.retryOnStatuses ?? []);
  const baseBackoff = opts.retryBackoffMs;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Linear backoff when caller specified retryBackoffMs (fast
      // proxy-rotation case), exponential otherwise.
      const wait = baseBackoff != null
        ? jitter(baseBackoff)
        : jitter(800 * Math.pow(2, attempt - 1));
      await new Promise(r => setTimeout(r, wait));
    }
    state.lastAt = Date.now();
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        headers,
        redirect: "follow",
        signal:   AbortSignal.timeout(opts.timeoutMs ?? 20_000),
        // Disable Bun's connection keep-alive when using a proxy so the
        // proxy's per-request IP rotation actually kicks in (otherwise
        // the pooled TCP connection pins us to the same backend IP for
        // every fetch, which defeats the whole point of a rotating
        // endpoint like Webshare's backbone).
        ...(opts.proxy ? { proxy: opts.proxy, keepalive: false } : {}),
      });

      // Persist Set-Cookie. Bun's Response exposes headers iterable.
      for (const [k, v] of res.headers.entries()) {
        if (k.toLowerCase() === "set-cookie") {
          for (const [name, value] of parseSetCookie(v)) {
            state.cookies.set(name, value);
          }
        }
      }

      if (res.status === 429 || res.status >= 500 || extraStatuses.has(res.status)) {
        logFetch({ url, status: res.status, ms: Date.now() - t0, bytes: 0, attempt: attempt + 1 });
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      const body = await res.text();
      logFetch({ url, status: res.status, ms: Date.now() - t0, bytes: body.length, attempt: attempt + 1 });
      return { status: res.status, url: res.url, body };
    } catch (err) {
      logFetchError({ url, attempt: attempt + 1, err: (err as Error).message ?? String(err) });
      lastErr = err;
    }
  }
  throw new Error(`fetchText failed for ${url}: ${(lastErr as Error)?.message ?? lastErr}`);
}
