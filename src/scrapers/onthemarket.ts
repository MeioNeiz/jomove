/**
 * OnTheMarket scraper.
 *
 * Both search and detail are Next.js pages with rich
 * `__NEXT_DATA__.props.initialReduxState` payloads:
 *   - search:  results.list[]   (30 per page, summary fields)
 *   - detail:  property         (full record incl. description)
 *
 * Pre-filter on summary (price/beds/outcode/student/let-status) so we
 * only fetch detail pages for survivors. Respect their
 * `Crawl-delay: 1` from robots.txt — set the minimum gap to 1.5s.
 */

import { fetchText } from "./http.ts";
import { writeResults, type ScrapedListing } from "./output.ts";
import { filterListing, type FilterResult, ALLOWED_POSTCODES, MAX_PRICE } from "./filters.ts";
import { filterImages } from "./images.ts";
import { parseAvailable } from "../field-parsers.ts";
import type { ScrapeReport } from "./registry.ts";
export type { ScrapeReport } from "./registry.ts";

const SEARCH_BASE =
  "https://www.onthemarket.com/to-rent/property/southampton/" +
  "?max-price=1150&min-bedrooms=1&max-bedrooms=2";

const PAGE_SIZE = 30;
const HOST_GAP_MS = 1500;

type OtmImage = {
  // Summary-page shape (search list).
  default?:   string;
  webp?:      string;
  // Detail-page shape — much richer. `url` is the same 81x55 thumb as
  // `default`; `largeUrl` is the 1024-wide variant we actually want.
  url?:       string;
  largeUrl?:  string;
  prefix?:    string;
  ext?:       string;
  geometries?: Record<string, { w: number; h: number; suffix: string }>;
};

/** Pick the largest sensible URL out of OTM's image record. */
function pickOtmImageUrl(img: any): string | null {
  if (!img) return null;
  if (typeof img === "string") return img;
  if (typeof img.largeUrl === "string") return img.largeUrl;
  if (typeof img.prefix === "string" && img.geometries) {
    // Largest first; OTM names them `hd` (1024) > `dc` (570) > `ls`/`mc` > `th`.
    for (const k of ["hd", "dc", "ls", "mc", "th"] as const) {
      const g = img.geometries[k];
      if (g?.suffix) {
        const ext = typeof img.ext === "string" ? img.ext : "jpg";
        return `${img.prefix}-${g.suffix}.${ext}`;
      }
    }
  }
  return img.default ?? img.url ?? null;
}
type OtmSummary = {
  id:                          number | string;
  "details-url":               string;
  address:                     string;
  "humanised-property-type":   string;
  features:                    string[];
  bedrooms:                    number;
  bathrooms:                   number | null;
  // OTM's payload originally returned this as a number; some time in 2026 they
  // started returning the human-rendered string ("£925 pcm (£213 pw)"). Treat
  // both shapes — the actual numeric pcm is parsed by `parseOtmPriceField`.
  price:                       number | string | null;
  "short-price":               string;
  "price-qualifier":           string | null;
  images:                      OtmImage[];
  "main-label":                string | null;
  "fees-description":          string | null;
  "fees-label":                string | null;
  agent:                       { name?: string; "company-name"?: string } | null;
  "days-since-added-reduced"?: number | null;
};

/**
 * OTM sometimes hands us `price: 925` (legacy) and sometimes
 * `price: "£925 pcm (£213 pw)"` (current). Always return a pcm number.
 *
 * "short-price" looks like "£925" so we prefer it if numeric parsing
 * fails on the main field.
 */
function parseOtmPriceField(s: OtmSummary): number | null {
  const cands: Array<number | string | null | undefined> = [
    s.price, s["short-price"],
  ];
  for (const c of cands) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
    if (typeof c !== "string") continue;

    // Prefer an explicit "£NNN pcm/pm" match (cheap parenthetical pw notes
    // come *after* the pcm figure on OTM: "£925 pcm (£213 pw)"). Fall back
    // to a "£NNN pw" only if no pcm appears.
    const pcm = c.match(/£\s*([\d,]+)(?:\.\d{2})?\s*(?:pcm|pm)\b/i);
    if (pcm) {
      const n = parseInt(pcm[1]!.replace(/,/g, ""), 10);
      if (Number.isFinite(n)) return n;
    }
    const pw = c.match(/£\s*([\d,]+)(?:\.\d{2})?\s*(?:p\/?w|per\s+week)\b/i);
    if (pw) {
      const n = parseInt(pw[1]!.replace(/,/g, ""), 10);
      if (Number.isFinite(n)) return Math.round(n * 52 / 12);
    }
    // Bare "£NNN" (e.g. "short-price": "£925") — assume pcm.
    const bare = c.match(/£\s*([\d,]+)/);
    if (bare) {
      const n = parseInt(bare[1]!.replace(/,/g, ""), 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function extractNextData(html: string): any {
  const m = html.match(/<script id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]!); } catch { return null; }
}

function outcodeFromAddress(a: string): string | null {
  const m = a.match(/\b(SO\d{1,2})\b/i);
  return m ? m[1]!.toUpperCase() : null;
}

function normaliseListingType(humanised: string | null | undefined): string {
  if (!humanised) return "flat";
  const lt = humanised.toLowerCase();
  if (/house\s*share/.test(lt))   return "houseshare";
  if (/studio/.test(lt))          return "studio";
  if (/maisonette/.test(lt))      return "maisonette";
  if (/flat|apartment/.test(lt))  return "flat";
  if (/house|terraced|semi|detached|bungalow/.test(lt)) return "house";
  return lt;
}

function pickFurnishedFromFeatures(features: string[]): string | null {
  for (const f of features) {
    const fl = f.toLowerCase();
    if (fl.includes("furnished") && fl.includes("unfurnished")) return "Optional";
    if (fl === "furnished" || fl.includes("part furnished")) {
      if (fl.includes("part"))   return "Part";
      return "Yes";
    }
    if (fl === "unfurnished" || fl.includes("unfurnished")) return "No";
  }
  return null;
}

function summaryPreFilter(s: OtmSummary): FilterResult {
  const price = parseOtmPriceField(s);
  if (price == null) return { pass: false, reason: "no price" };
  if (price > MAX_PRICE) return { pass: false, reason: `price £${price} > £${MAX_PRICE}` };
  if (s.bedrooms < 1 || s.bedrooms > 2) {
    return { pass: false, reason: `beds ${s.bedrooms} outside 1-2` };
  }
  const out = outcodeFromAddress(s.address);
  if (!out || !ALLOWED_POSTCODES.has(out)) {
    return { pass: false, reason: `outcode ${out ?? "?"} not allowed` };
  }
  const label = (s["main-label"] ?? "").toLowerCase();
  if (label.includes("let agreed") || label.includes("under offer")) {
    return { pass: false, reason: `status: ${s["main-label"]}` };
  }
  return { pass: true };
}

async function fetchSearchPage(page: number): Promise<{ list: OtmSummary[]; total: number } | null> {
  const url = page <= 1 ? SEARCH_BASE : `${SEARCH_BASE}&page=${page}`;
  const res = await fetchText(url, { minGapMs: HOST_GAP_MS });
  if (res.status !== 200) return null;
  const data = extractNextData(res.body);
  const sr = data?.props?.initialReduxState?.results;
  if (!sr?.list) return null;
  const totalStr = sr?.paginationControls?.total ?? "0";
  const total = parseInt(String(totalStr).replace(/[^\d]/g, ""), 10) || 0;
  return { list: sr.list as OtmSummary[], total };
}

function buildFromDetail(s: OtmSummary, prop: any): ScrapedListing | null {
  if (prop?.student === true) return null;
  if ((prop?.propertyLabels ?? []).some((l: any) =>
    typeof l === "string" && /let agreed|under offer/i.test(l))) return null;
  const price = parseOtmPriceField(s);
  if (price == null) return null;

  const outcode = outcodeFromAddress(prop?.displayAddress ?? s.address);
  // OnTheMarket usually only shows outcode publicly. No incode in summary.
  // Try detail address for a full postcode.
  const pcFullMatch = (prop?.displayAddress ?? s.address)
    .match(/\b(SO\d{1,2})\s+(\d[A-Z]{2})\b/i);
  const postcodeFull = pcFullMatch ? `${pcFullMatch[1]!.toUpperCase()} ${pcFullMatch[2]!.toUpperCase()}` : null;

  const description = (prop?.description ?? "").replace(/\r\n/g, "\n").trim() || null;
  const features: string[] = Array.isArray(prop?.features)
    ? prop.features.filter(Boolean).map((f: any) => String(f).trim())
    : (s.features ?? []).filter(Boolean).map(String);

  const imageObjs = Array.isArray(prop?.images) ? prop.images : s.images;
  const imageUrls = imageObjs
    .map(pickOtmImageUrl)
    .filter((u: string | null): u is string => !!u);
  const images = filterImages(imageUrls);

  const furnished = pickFurnishedFromFeatures(features);

  // Parking from features.
  let parking: string | null = null;
  for (const f of features) {
    const fl = f.toLowerCase();
    if (fl.includes("allocated parking"))   { parking = "allocated"; break; }
    if (fl.includes("off-street parking") || fl.includes("off street parking")) { parking = "off-street"; break; }
    if (fl.includes("driveway"))            { parking = "driveway"; break; }
    if (fl.includes("permit"))              { parking = "permit"; break; }
    if (fl === "parking" || fl.includes("garage")) { parking = "allocated"; break; }
  }

  // Available date — OnTheMarket buries it in lettingDetails.
  const ld = prop?.lettingDetails ?? {};
  const available =
    ld.availableFrom ??
    ld.dateAvailable ??
    ld.letAvailableDate ??
    (prop?.toRent ? null : null);

  const deposit = typeof ld.deposit === "number" ? ld.deposit
    : ld.deposit && typeof ld.deposit === "string"
      ? parseInt(ld.deposit.replace(/[^\d]/g, ""), 10) || null
      : null;

  const agentName = prop?.agent?.companyName ?? prop?.agent?.name ?? s.agent?.["company-name"] ?? s.agent?.name ?? null;

  return {
    address:       prop?.displayAddress ?? s.address,
    price_pcm:     price,
    source_url:    `https://www.onthemarket.com/details/${s.id}/`,
    listing_type:  normaliseListingType(prop?.humanisedPropertyType ?? s["humanised-property-type"]),
    beds:          prop?.bedrooms ?? s.bedrooms ?? null,
    baths:         prop?.bathrooms ?? s.bathrooms ?? null,
    furnished,
    parking,
    epc:           null, // OTM doesn't expose EPC letter in JSON.
    deposit,
    available,
    postcode_area: outcode,
    postcode_full: postcodeFull,
    agent_name:    agentName,
    description,
    key_features:  features,
    images,
  };
}

export async function scrapeOnTheMarket(): Promise<ScrapeReport> {
  const report: ScrapeReport = {
    portal: "onthemarket", written: 0, skipped: [], errors: [], listings: [],
  };

  // Page 1 → learn total result count.
  let first;
  try { first = await fetchSearchPage(1); }
  catch (err) { report.errors.push(`search page 1: ${(err as Error).message}`); return report; }
  if (!first) { report.errors.push("search page 1: no payload"); return report; }

  const all: OtmSummary[] = [...first.list];
  const totalPages = Math.max(1, Math.ceil(first.total / PAGE_SIZE));
  for (let pg = 2; pg <= totalPages; pg++) {
    try {
      const p = await fetchSearchPage(pg);
      if (p) all.push(...p.list);
    } catch (err) {
      report.errors.push(`search page ${pg}: ${(err as Error).message}`);
    }
  }

  // De-dup by id (sponsored slots can repeat).
  const byId = new Map<number, OtmSummary>();
  for (const s of all) if (!byId.has(s.id)) byId.set(s.id, s);

  const survivors: OtmSummary[] = [];
  for (const s of byId.values()) {
    const f = summaryPreFilter(s);
    if (!f.pass) report.skipped.push({ id: s.id, reason: f.reason });
    else survivors.push(s);
  }

  const listings: ScrapedListing[] = [];
  for (const s of survivors) {
    const url = `https://www.onthemarket.com/details/${s.id}/`;
    let res;
    try {
      res = await fetchText(url, { minGapMs: HOST_GAP_MS, referer: SEARCH_BASE });
    } catch (err) {
      report.errors.push(`detail ${s.id}: ${(err as Error).message}`);
      continue;
    }
    if (res.status !== 200) {
      report.skipped.push({ id: s.id, reason: `HTTP ${res.status}` });
      continue;
    }
    const nd = extractNextData(res.body);
    const prop = nd?.props?.initialReduxState?.property;
    if (!prop) {
      report.skipped.push({ id: s.id, reason: "no property payload" });
      continue;
    }
    const built = buildFromDetail(s, prop);
    if (!built) {
      report.skipped.push({ id: s.id, reason: "student / let-agreed" });
      continue;
    }

    const avail = parseAvailable(built.available ?? "");
    const final: FilterResult = filterListing({
      price_pcm:      built.price_pcm,
      beds:           built.beds ?? null,
      postcode_area:  built.postcode_area ?? null,
      available_date: avail.iso,
      listing_type:   built.listing_type ?? null,
      description:    built.description ?? null,
      address:        built.address,
    });
    if (!final.pass) {
      report.skipped.push({ id: s.id, reason: final.reason });
      continue;
    }
    listings.push(built);
  }

  writeResults("onthemarket", listings);
  report.written = listings.length;
  report.listings = listings;
  return report;
}
