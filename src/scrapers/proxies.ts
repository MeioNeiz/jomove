/**
 * Free-proxy rotation — emergency fallback for portals that have
 * IP-blocked our server. Fetches a public proxy list, races candidates
 * in parallel through a caller-supplied validator, returns the first
 * one that returns a real page along with the body it already pulled
 * (so the caller doesn't have to re-fetch through the same flaky proxy).
 *
 * Free proxies are slow and unreliable by nature; only use when the
 * direct path is hard-blocked. The validator must distinguish real
 * content from WAF/captcha pages because dodgy proxies happily inject
 * their own block screens.
 */

const PROXY_LIST_URLS = [
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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
  body:     string;
  status:   number;
  finalUrl: string;
};

export async function pickWorkingProxy(
  testUrl: string,
  validator: (body: string) => boolean,
  opts: {
    concurrency?:   number;
    maxCandidates?: number;
    perTryMs?:      number;
    /** Proxies known to be bad — caller passes its blacklist on re-picks. */
    skip?:          Set<string>;
  } = {},
): Promise<ProxyPick | null> {
  const list = await loadProxyList();
  if (list.length === 0) return null;

  const candidates  = list.slice(0, opts.maxCandidates ?? 400);
  const concurrency = opts.concurrency ?? 30;
  const perTryMs    = opts.perTryMs    ?? 8000;
  const skip        = opts.skip ?? new Set<string>();

  let cursor = 0;
  let result: ProxyPick | null = null;

  const worker = async () => {
    while (result === null && cursor < candidates.length) {
      const proxy = `http://${candidates[cursor++]!}`;
      if (skip.has(proxy)) continue;
      try {
        const res = await fetch(testUrl, {
          proxy,
          headers: {
            "User-Agent":      UA,
            "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-GB,en;q=0.9",
          },
          redirect: "follow",
          signal:   AbortSignal.timeout(perTryMs),
        });
        if (res.status !== 200) continue;
        const body = await res.text();
        if (!validator(body)) continue;
        if (result === null) result = { proxy, body, status: res.status, finalUrl: res.url };
      } catch { /* free proxies fail constantly — ignore */ }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return result;
}

/** Reset cached list — useful for tests or recovering from a stale set. */
export function clearProxyCache(): void { listCache = null; }
