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
 */

const PROXY_LIST_URLS = [
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const HEADERS = {
  "User-Agent":      UA,
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
};

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
  const list = await loadProxyList();
  if (list.length === 0) return [];

  const candidates  = list.slice(0, opts.maxCandidates ?? 600);
  const concurrency = opts.concurrency ?? 40;
  const perTryMs    = opts.perTryMs    ?? 8000;
  const skip        = opts.skip ?? new Set<string>();
  const sustainUrl  = opts.sustainUrl;

  let cursor = 0;
  const results: ProxyPick[] = [];

  const worker = async () => {
    while (results.length < count && cursor < candidates.length) {
      const proxy = `http://${candidates[cursor++]!}`;
      if (skip.has(proxy)) continue;
      const first = await probeOnce(proxy, testUrl, validator, perTryMs);
      if (!first) continue;
      if (sustainUrl) {
        const second = await probeOnce(proxy, sustainUrl, validator, perTryMs);
        if (!second) continue;
      }
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
