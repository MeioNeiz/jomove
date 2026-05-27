/**
 * OpenRent scraper.
 *
 * Discovery: search page embeds a JS array `PROPERTYIDS = [id, id, ...]`
 * Detail:    GET /{id} -> 301 to slug URL. HTML carries:
 *              - <title> = "Southampton - <type/beds> <address>, <SO**> - To Rent Now for £<price> p/m"
 *              - tables for Deposit / Available From / Furnishing / EPC Rating / Garden / Parking
 *              - <div id="descriptionText">: the listing blurb
 *              - imagescdn.openrent.co.uk/listings/<id>/...JPG: photo URLs
 */

import { fetchText } from "./http.ts";
import {
  findWorkingProxies,
  flushProxyHealth,
  recordProxyFail,
  recordProxyOk,
} from "./proxies.ts";
import { writeResults, type ScrapedListing } from "./output.ts";
import { filterListing, type FilterResult } from "./filters.ts";
import { filterImages } from "./images.ts";
import { parseAvailable } from "../field-parsers.ts";
import type { ScrapeReport } from "./registry.ts";
export type { ScrapeReport } from "./registry.ts";

const SEARCH_URL =
  "https://www.openrent.co.uk/properties-to-rent/southampton" +
  "?term=Southampton&prices_max=1150&bedrooms_min=1&bedrooms_max=2";

// Second WAF-fronted URL used purely to filter out one-shot free proxies
// during proxy selection. Different query params so it doesn't hit the
// proxy's response cache.
const SUSTAIN_URL =
  "https://www.openrent.co.uk/properties-to-rent/southampton" +
  "?term=Southampton&prices_max=2500&bedrooms_min=1&bedrooms_max=3";

const TITLE_RE = /^Southampton\s+-\s+(.+?)\s+-\s+To Rent Now/i;
const ID_RE    = /var\s+PROPERTYIDS\s*=\s*\[([0-9,\s]+)\]/;

function decode(s: string): string {
  return s
    .replace(/&#xA0;/gi, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#xA3;/gi, "£")
    .replace(/&pound;/gi, "£")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Pull k/v rows out of an HTML table. */
function tableRows(html: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const cells = [...m[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => c[1]!);
    if (cells.length < 2) continue;
    const key = stripTags(cells[0]!);
    // Boolean rows: value cell contains an svg with .text-success or .text-danger.
    // Render as "yes"/"no" so downstream parsers can treat them like text.
    const raw = cells[1]!;
    let val = stripTags(raw);
    if (!val) {
      if (/class=[\"'][^\"']*text-success/i.test(raw)) val = "yes";
      else if (/class=[\"'][^\"']*text-danger/i.test(raw)) val = "no";
    }
    if (key) out.push([key, val]);
  }
  return out;
}

function findKV(rows: Array<[string, string]>, key: RegExp): string | null {
  for (const [k, v] of rows) if (key.test(k)) return v;
  return null;
}

function parseTitle(title: string): {
  bedsCount: number | null;
  listingType: string;
  address: string;
  postcodeArea: string | null;
  price: number | null;
} | null {
  const decoded = decode(title).replace(/\s+/g, " ").trim();
  const m = decoded.match(TITLE_RE);
  if (!m) return null;
  const body = m[1]!;

  // Body is "<type-with-beds> <address-bits>, SOxx". Address bits can have
  // commas (e.g. "Cumberland Place"). Split off the last comma-segment if it
  // looks like a postcode area.
  const segments = body.split(",").map(s => s.trim());
  let postcodeArea: string | null = null;
  if (segments.length >= 2) {
    const last = segments[segments.length - 1]!;
    const pm = last.match(/\bSO\d{1,2}\b/i);
    if (pm) {
      postcodeArea = pm[0].toUpperCase();
      segments.pop();
    }
  }

  const typeAndFirst = segments[0]!;
  // "1 Bed Flat", "Studio Flat", "Room in a Shared Flat", "1 Bed Terraced House"
  const bedsM = typeAndFirst.match(/^(\d+)\s+Bed\s+(.+)$/i);
  let bedsCount: number | null = null;
  let listingType = typeAndFirst;
  if (bedsM) {
    bedsCount = parseInt(bedsM[1]!, 10);
    listingType = bedsM[2]!.trim();
  } else if (/^Studio\b/i.test(typeAndFirst)) {
    bedsCount = 1;
    listingType = "studio";
  } else if (/^Room\b/i.test(typeAndFirst)) {
    bedsCount = 1;
    listingType = "houseshare";
  } else {
    listingType = typeAndFirst;
  }

  // Address = remaining segments joined back, plus the city implied.
  const addrSegments = segments.slice(1);
  const address = addrSegments.length > 0
    ? `${addrSegments.join(", ")}, Southampton`
    : "Southampton";

  // Normalise listingType down to the markdown vocab. Order matters —
  // "houseshare" must beat "house" because /house/ matches both.
  const lt = listingType.toLowerCase();
  let normType: string;
  if      (/houseshare|house\s+share|room\s+in/.test(lt)) normType = "houseshare";
  else if (/studio/.test(lt))                              normType = "studio";
  else if (/maisonette/.test(lt))                          normType = "maisonette";
  else if (/flat/.test(lt))                                normType = "flat";
  else if (/house/.test(lt))                               normType = "house";
  else                                                     normType = lt;

  // Price: appears as "£910.00 p/m" right after the body.
  const priceM = decoded.match(/£([\d,]+)(?:\.\d{2})?\s*p\/m/i);
  const price = priceM ? parseInt(priceM[1]!.replace(/,/g, ""), 10) : null;

  return { bedsCount, listingType: normType, address, postcodeArea, price };
}

function parsePostcodeFromBody(body: string): string | null {
  // Try a UK full postcode anywhere in the body. Prefer one that appears
  // near "postcode" / address blocks but cheap regex is fine.
  const m = body.match(/\b(SO\d{1,2})\s*(\d[A-Z]{2})\b/i);
  return m ? `${m[1]!.toUpperCase()} ${m[2]!.toUpperCase()}` : null;
}

function parseDescription(body: string): string | null {
  const m = body.match(/<div[^>]+id=["']descriptionText["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!m) return null;
  // Preserve paragraph breaks: replace closing block tags with newlines
  // before stripping.
  const withBreaks = m[1]!
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h\d)>/gi, "\n");
  return decode(withBreaks.replace(/<[^>]+>/g, " "))
    .split("\n")
    .map(l => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000) || null;
}

function parseImages(body: string, listingId: string): string[] {
  // Listing-specific photos live under imagescdn.openrent.co.uk/listings/<id>/.
  const escaped = listingId.replace(/[^\d]/g, "");
  const re = new RegExp(`https?:\\/\\/imagescdn\\.openrent\\.co\\.uk\\/listings\\/${escaped}\\/[\\w_.-]+\\.(?:JPG|jpg|jpeg|png)`, "gi");
  const urls = [...body.matchAll(re)].map(m => m[0]);
  // Normalise to https.
  return filterImages(urls.map(u => u.replace(/^http:/, "https:")));
}

function parseDeposit(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/£?\s*([\d,]+)(?:\.\d{2})?/);
  return m ? parseInt(m[1]!.replace(/,/g, ""), 10) : null;
}

function parseEpcRating(s: string | null): string | null {
  if (!s) return null;
  const m = s.match(/\b([A-G])\b/);
  return m ? m[1]! : null;
}

function parseParkingFromYesNo(s: string | null): string | null {
  if (!s) return null;
  const sl = s.toLowerCase();
  if (sl === "yes") return "off-street";
  if (sl === "no")  return "none";
  return s;
}

function parseFurnishingValue(s: string | null): string | null {
  if (!s) return null;
  const sl = s.toLowerCase();
  if (sl.includes("part"))                 return "Part";
  if (sl.startsWith("unfurnished") || sl === "no") return "No";
  if (sl.includes("optional"))             return "Optional";
  if (sl.startsWith("furnished") || sl === "yes")  return "Yes";
  return s;
}

function isStudentsOnly(rows: Array<[string, string]>): boolean {
  return findKV(rows, /Students Only/i)?.toLowerCase() === "yes";
}

function buildListing(id: string, finalUrl: string, body: string): ScrapedListing | null {
  const titleHtml = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!titleHtml) return null;
  const t = parseTitle(titleHtml);
  if (!t || t.price == null) return null;

  const rows: Array<[string, string]> = [];
  for (const m of body.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    rows.push(...tableRows(m[1]!));
  }

  const deposit  = parseDeposit(findKV(rows, /^\s*Deposit\b/i));
  const epc      = parseEpcRating(findKV(rows, /EPC Rating/i));
  const avail    = parseAvailable(findKV(rows, /Available From/i) ?? "");
  const furn     = parseFurnishingValue(findKV(rows, /Furnishing/i));
  const parking  = parseParkingFromYesNo(findKV(rows, /^\s*Parking\b/i));
  const billsInc = findKV(rows, /Bills Included/i)?.toLowerCase() === "yes";

  const description = parseDescription(body);
  const images      = parseImages(body, id);
  const postcodeFull = parsePostcodeFromBody(body);

  const keyFeatures: string[] = [];
  if (findKV(rows, /^\s*Garden\b/i)?.toLowerCase() === "yes")    keyFeatures.push("Garden");
  if (findKV(rows, /Fireplace/i)?.toLowerCase() === "yes")       keyFeatures.push("Fireplace");
  if (findKV(rows, /Pets Allowed/i)?.toLowerCase() === "yes")    keyFeatures.push("Pets allowed");
  if (findKV(rows, /Smokers Allowed/i)?.toLowerCase() === "yes") keyFeatures.push("Smokers allowed");
  if (billsInc)                                                  keyFeatures.push("Bills included");
  if (findKV(rows, /DSS\/?LHA/i)?.toLowerCase() === "yes")        keyFeatures.push("DSS/LHA accepted");

  return {
    address:        t.address,
    price_pcm:      t.price,
    source_url:     finalUrl,
    listing_type:   t.listingType,
    beds:           t.bedsCount,
    baths:          null,
    furnished:      furn,
    parking,
    epc,
    deposit,
    available:      avail.raw,
    postcode_area:  t.postcodeArea,
    postcode_full:  postcodeFull,
    agent_name:     null,    // OpenRent is landlord-direct
    description,
    key_features:   keyFeatures,
    images,
  };
}

type ListingResult =
  | { kind: "listing"; listing: ScrapedListing }
  | { kind: "skip";    reason: string }
  | { kind: "error";   error: Error };

async function fetchAndProcess(
  id:       string,
  proxy:    string | undefined,
  opts:     { onPaid: boolean; onProxy: boolean },
): Promise<ListingResult> {
  let res;
  try {
    res = await fetchText(`https://www.openrent.co.uk/${id}`, {
      minGapMs: opts.onProxy ? 600 : 1500,
      referer:  SEARCH_URL,
      proxy,
      ...(opts.onProxy && !opts.onPaid ? { retries: 0, timeoutMs: 10_000 } : {}),
      ...(opts.onPaid ? {
        retries:         12,
        retryOnStatuses: [405],
        retryBackoffMs:  300,
        timeoutMs:       12_000,
      } : {}),
    });
  } catch (err) {
    return { kind: "error", error: err as Error };
  }
  if (res.status !== 200) return { kind: "skip", reason: `HTTP ${res.status}` };

  const built = buildListing(id, res.url, res.body);
  if (!built) return { kind: "skip", reason: "unparseable" };

  const rows: Array<[string, string]> = [];
  for (const m of res.body.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    rows.push(...tableRows(m[1]!));
  }
  if (isStudentsOnly(rows)) return { kind: "skip", reason: "students only" };

  const avail = parseAvailable(built.available ?? "");
  const f: FilterResult = filterListing({
    price_pcm:      built.price_pcm,
    beds:           built.beds ?? null,
    postcode_area:  built.postcode_area ?? null,
    available_date: avail.iso,
    listing_type:   built.listing_type ?? null,
    description:    built.description ?? null,
    address:        built.address,
  });
  if (!f.pass) return { kind: "skip", reason: f.reason };
  return { kind: "listing", listing: built };
}

export async function scrapeOpenRent(): Promise<ScrapeReport> {
  const report: ScrapeReport = {
    portal: "openrent", written: 0, skipped: [], errors: [], listings: [],
  };

  // Paid rotating endpoint (e.g. Webshare): one URL that rotates IPs
  // server-side. When present, we trust it for the whole run and don't
  // touch the free-proxy fallback unless even it gets WAF-blocked.
  const PAID_PROXY = (process.env.OPENRENT_PROXY ?? "").trim() || null;

  let search;
  let proxyPool: string[] = PAID_PROXY ? [PAID_PROXY] : [];
  let onPaid = PAID_PROXY != null;
  const badProxies = new Set<string>();
  try {
    search = await fetchText(SEARCH_URL, {
      minGapMs: 1500,
      // Paid backbone rotates IPs server-side per request; ~30% of
      // rotated IPs are WAF-clean. Retry on 405 so we walk through
      // the rotation until one passes. Linear backoff keeps the
      // search overhead bounded to a few seconds.
      retries: PAID_PROXY ? 12 : 0,
      ...(PAID_PROXY ? {
        proxy: PAID_PROXY,
        retryOnStatuses: [405],
        retryBackoffMs:  300,
        timeoutMs:       15_000,
      } : {}),
    });
  } catch (err) {
    report.errors.push(`search fetch failed: ${(err as Error).message}`);
    return report;
  }
  // OpenRent fronts the search + detail pages with AWS WAF, which
  // serves a captcha page as HTTP 405 to flagged IPs (e.g. Oracle
  // Cloud). Fall back to a free-proxy pool — warm-pool first (recently
  // healthy from a past run), then sustain-tested fresh candidates.
  if (search.status === 405) {
    if (onPaid) {
      report.errors.push("paid proxy WAF-blocked — falling back to free pool");
      onPaid = false;
      proxyPool = [];
    }
    const picks = await findWorkingProxies(
      SEARCH_URL,
      b => ID_RE.test(b),
      // Larger initial pool: dies slower as the run drains it.
      8,
      { sustainUrl: SUSTAIN_URL, skip: badProxies },
    );
    if (picks.length === 0) {
      report.errors.push("search HTTP 405 (no working free proxy found)");
      flushProxyHealth();
      return report;
    }
    proxyPool = picks.map(p => p.proxy);
    search    = { status: 200, url: picks[0]!.finalUrl, body: picks[0]!.body };
  }
  if (search.status !== 200) {
    report.errors.push(`search HTTP ${search.status}`);
    flushProxyHealth();
    return report;
  }
  const idMatch = search.body.match(ID_RE);
  if (!idMatch) {
    report.errors.push("PROPERTYIDS array not found on search page");
    flushProxyHealth();
    return report;
  }
  const ids = idMatch[1]!.split(",").map(s => s.trim()).filter(Boolean);

  const onProxy = proxyPool.length > 0;
  const listings: ScrapedListing[] = [];

  if (onPaid) {
    // Paid backbone: parallel worker pool. Each in-flight request hits
    // a freshly rotated IP, so concurrency multiplies our effective
    // throughput without correlating failures. Concurrency of 3 keeps
    // run time inside the 15-min systemd timeout even at ~5s/listing.
    const CONCURRENCY = 3;
    let cursor = 0;
    let consecutiveFails = 0;
    let bail = false;

    const worker = async () => {
      while (!bail) {
        const i = cursor++;
        if (i >= ids.length) return;
        const id = ids[i]!;
        const r = await fetchAndProcess(id, PAID_PROXY!, { onPaid: true, onProxy: true });
        if (r.kind === "listing") {
          listings.push(r.listing);
          consecutiveFails = 0;
        } else if (r.kind === "skip") {
          report.skipped.push({ id, reason: r.reason });
          consecutiveFails = 0;
        } else {
          report.errors.push(`detail ${id} fetch failed: ${r.error.message}`);
          consecutiveFails++;
          // Paid endpoint completely broken (auth, quota, network):
          // bail out instead of grinding through all 230 listings.
          if (consecutiveFails >= 12) {
            report.errors.push(`paid proxy failing repeatedly — stopped at ${cursor}/${ids.length}`);
            bail = true;
          }
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  } else {
    // Free pool (or direct): rotate proxies on consecutive failures,
    // refill from the public list if the pool empties, hard-cap total
    // runtime so a bad-luck run can't drag the whole auto-scrape past
    // its budget.
    const PROXY_RUN_BUDGET_MS = 5 * 60_000;
    const PROXY_FAIL_STREAK    = 2;
    let proxy      = proxyPool[0];
    let failStreak = 0;
    const runStart = Date.now();

    for (const id of ids) {
      if (onProxy && Date.now() - runStart > PROXY_RUN_BUDGET_MS) {
        report.errors.push(`proxy budget exceeded — stopped at ${listings.length}/${ids.length}`);
        break;
      }
      const r = await fetchAndProcess(id, proxy, { onPaid: false, onProxy });
      if (r.kind === "listing") {
        listings.push(r.listing);
        if (onProxy && proxy) recordProxyOk(proxy);
        failStreak = 0;
      } else if (r.kind === "skip") {
        report.skipped.push({ id, reason: r.reason });
        if (onProxy && proxy) recordProxyOk(proxy);
        failStreak = 0;
      } else {
        report.errors.push(`detail ${id} fetch failed: ${r.error.message}`);
        if (onProxy && proxy) {
          recordProxyFail(proxy);
          failStreak++;
          if (failStreak >= PROXY_FAIL_STREAK) {
            badProxies.add(proxy);
            proxyPool = proxyPool.filter(p => p !== proxy);
            if (proxyPool.length === 0) {
              const more = await findWorkingProxies(
                SEARCH_URL,
                b => ID_RE.test(b),
                5,
                { sustainUrl: SUSTAIN_URL, skip: badProxies },
              );
              if (more.length === 0) {
                report.errors.push(`proxy pool exhausted — stopped at ${listings.length}/${ids.length}`);
                break;
              }
              proxyPool = more.map(p => p.proxy);
            }
            proxy      = proxyPool[0];
            failStreak = 0;
          }
        }
      }
    }
  }

  writeResults("openrent", listings);
  report.written = listings.length;
  report.listings = listings;
  flushProxyHealth();
  return report;
}
