/**
 * HTTP-only "is this listing still live?" check.
 *
 * Hard constraint: NO false positives. We never want to mark an active
 * listing as let_agreed by mistake. So we only look at high-signal page
 * regions (title, og:title/description, h1) — not the full body, where
 * "let agreed" might appear in a related-properties carousel or a status
 * filter dropdown.
 *
 * Triage:
 *   - HTTP 404/410, or 30x to the portal's index → removed
 *   - HTTP 2xx and a kill phrase appears in title/og/h1 → removed
 *   - HTTP 403/429 → error (anti-bot interstitial — leave active)
 *   - Other 4xx/5xx or network failure → error
 *   - HTTP 2xx with nothing definitive → alive
 *
 * Zoopla is skipped entirely (their Cloudflare returns 403 to plain
 * fetches). Use the AI follow-up in the /verify skill for Zoopla.
 */

export type LinkStatus = "removed" | "alive" | "error" | "skipped";

export type LinkCheck = {
  url:          string;
  source:       string;
  status:       LinkStatus;
  reason:       string;
  http_status?: number;
};

import { PORTALS_BY_ID } from "../scrapers/registry.ts";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Final-URL paths that mean the listing redirected to a portal index —
// usually a sign the listing was removed.
const INDEX_PATH_HINTS = [
  /\/properties-to-rent\/?$/i,    // openrent
  /\/property-to-rent\/?$/i,       // rightmove
  /\/to-rent\/property\//i,        // zoopla, onthemarket
  /\/property-to-rent\/southampton/i,
  /^\/$/,
];

/** Extract high-signal status text from the page (title + og + h1 only). */
function extractStatusText(body: string): string {
  const parts: string[] = [];
  const title = body.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  if (title) parts.push(title[1]!);

  const ogPatterns = [
    /<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']{0,300})["']/i,
    /<meta[^>]+content=["']([^"']{0,300})["'][^>]+(?:property|name)=["']og:title["']/i,
    /<meta[^>]+(?:property|name)=["']og:description["'][^>]+content=["']([^"']{0,300})["']/i,
    /<meta[^>]+content=["']([^"']{0,300})["'][^>]+(?:property|name)=["']og:description["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,300})["']/i,
  ];
  for (const re of ogPatterns) {
    const m = body.match(re);
    if (m) parts.push(m[1]!);
  }

  // First two <h1> elements only — limits exposure to "related properties".
  const h1Re = /<h1[^>]*>([\s\S]{0,200}?)<\/h1>/gi;
  let h1Match: RegExpExecArray | null;
  let h1Count = 0;
  while ((h1Match = h1Re.exec(body)) && h1Count < 2) {
    parts.push(h1Match[1]!);
    h1Count++;
  }

  // Strip HTML tags inside the captured snippets so phrase matching is clean.
  return parts.join("\n").replace(/<[^>]+>/g, " ");
}

export async function checkLink(url: string, source: string): Promise<LinkCheck> {
  const portal = PORTALS_BY_ID[source.toLowerCase()];
  if (portal?.httpVerify.skip) {
    return {
      url, source, status: "skipped",
      reason: "anti-bot — use AI follow-up",
    };
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent":      UA,
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      redirect: "follow",
      signal:   AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return {
      url, source, status: "error",
      reason: `fetch failed: ${(err as Error).message || String(err)}`,
    };
  }

  const http = res.status;

  if (http === 404 || http === 410) {
    return { url, source, status: "removed", reason: `HTTP ${http}`, http_status: http };
  }
  if (http >= 500) {
    return { url, source, status: "error", reason: `HTTP ${http}`, http_status: http };
  }
  // Cloudflare/anti-bot interstitials usually return 403 — treat as error,
  // not removed, so we don't wipe healthy listings on a single bad fetch.
  if (http === 403 || http === 429) {
    return { url, source, status: "error", reason: `HTTP ${http} (blocked?)`, http_status: http };
  }
  if (http >= 400) {
    return { url, source, status: "error", reason: `HTTP ${http}`, http_status: http };
  }

  // Final URL after redirects — if we landed on the portal index, treat as removed.
  if (res.url && res.url !== url) {
    try {
      const finalPath = new URL(res.url).pathname;
      if (INDEX_PATH_HINTS.some(re => re.test(finalPath))) {
        return {
          url, source, status: "removed",
          reason: `redirected to ${res.url}`, http_status: http,
        };
      }
    } catch { /* malformed final URL — fall through to body check */ }
  }

  let body: string;
  try {
    body = await res.text();
  } catch (err) {
    return {
      url, source, status: "error",
      reason: `read body failed: ${(err as Error).message || String(err)}`,
      http_status: http,
    };
  }

  // Match kill phrases ONLY in high-signal regions to avoid being fooled
  // by "related properties" sections or status-filter dropdowns where
  // "let agreed" appears as ambient text.
  const statusText = extractStatusText(body);
  const patterns = portal?.httpVerify.removedPhrases ?? [];
  for (const re of patterns) {
    if (re.test(statusText)) {
      return {
        url, source, status: "removed",
        reason: `title/og/h1 matched /${re.source}/${re.flags}`,
        http_status: http,
      };
    }
  }

  return { url, source, status: "alive", reason: "OK", http_status: http };
}

export type CheckLinksOpts = {
  concurrency?: number;
  delayMs?:     number;
  onProgress?:  (done: number, total: number) => void;
};

export async function checkLinks(
  items: Array<{ url: string; source: string }>,
  opts: CheckLinksOpts = {},
): Promise<LinkCheck[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  const delayMs     = Math.max(0, opts.delayMs     ?? 200);
  const results: LinkCheck[] = new Array(items.length);
  let cursor = 0;
  let done   = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      const item = items[idx]!;
      results[idx] = await checkLink(item.url, item.source);
      done++;
      opts.onProgress?.(done, items.length);
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
