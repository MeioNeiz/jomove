/**
 * Rightmove scraper.
 *
 * Discovery: /property-to-rent/Southampton.html embeds a Next.js
 * payload at `<script id="__NEXT_DATA__">` listing 24 properties per
 * page. Iterate pages via `&index=0,24,48,...` until the page count
 * runs out.
 *
 * Each summary has enough to apply hard filters (price, bedrooms,
 * outcode, letAvailableDate, students) so we only fetch detail pages
 * for properties that survive — cuts ~400 fetches down to ~50.
 *
 * Detail: `/properties/{id}` embeds `window.PAGE_MODEL = { data: "...
 * encoding: "on" }`. The `data` field is a JSON-stringified array
 * using a Rightmove-specific flatted encoding (numeric refs into the
 * same array). `unflatten()` resolves it.
 */

import { fetchText } from "./http.ts";
import { writeResults, type ScrapedListing } from "./output.ts";
import { filterListing, type FilterResult, ALLOWED_POSTCODES, MAX_PRICE } from "./filters.ts";
import { filterImages } from "./images.ts";
import { parseAvailable } from "../field-parsers.ts";
import { DEADLINE } from "../config.ts";

const SEARCH_BASE =
  "https://www.rightmove.co.uk/property-to-rent/Southampton.html" +
  "?minBedrooms=1&maxBedrooms=2&maxPrice=1150&radius=0";

const PAGE_SIZE = 24;

export type ScrapeReport = {
  portal:  string;
  written: number;
  skipped: Array<{ id: string | number; reason: string }>;
  errors:  string[];
};

type RmSummary = {
  id:                number;
  propertyUrl:       string;
  displayAddress:    string;
  bedrooms:          number;
  bathrooms:         number | null;
  propertySubType:   string;
  letAvailableDate:  string | null;
  summary:           string;
  students:          boolean;
  price:             { amount: number; frequency: string };
  images:            Array<{ url: string; srcUrl?: string }>;
  location:          { latitude: number; longitude: number } | null;
  displayStatus?:    string;
};

function decodeHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&pound;/gi, "£")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

function unflatten(arr: unknown[]): unknown {
  const cache = new Map<number, unknown>();
  function walk(i: number): unknown {
    if (cache.has(i)) return cache.get(i);
    const v = arr[i];
    if (v === null || typeof v !== "object") {
      cache.set(i, v);
      return v;
    }
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      cache.set(i, out);
      for (const ref of v) out.push(typeof ref === "number" ? walk(ref) : ref);
      return out;
    }
    const out: Record<string, unknown> = {};
    cache.set(i, out);
    for (const [k, ref] of Object.entries(v as Record<string, unknown>)) {
      out[k] = typeof ref === "number" ? walk(ref) : ref;
    }
    return out;
  }
  return walk(0);
}

function extractNextData(html: string): any {
  const m = html.match(/<script id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]!); } catch { return null; }
}

function extractPageModel(html: string): any {
  const start = html.indexOf("PAGE_MODEL = ");
  if (start < 0) return null;
  const after = html.slice(start + "PAGE_MODEL = ".length);
  const end = after.indexOf("};") + 1;
  if (end <= 0) return null;
  let wrapped;
  try { wrapped = JSON.parse(after.slice(0, end)); } catch { return null; }
  if (!wrapped?.data) return null;
  let arr;
  try { arr = JSON.parse(wrapped.data); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  try { return unflatten(arr); } catch { return null; }
}

function outcodeFromAddress(a: string): string | null {
  const m = a.match(/\b(SO\d{1,2})\b/i);
  return m ? m[1]!.toUpperCase() : null;
}

function normaliseFurnish(s: string | null | undefined): string | null {
  if (!s) return null;
  const sl = s.toLowerCase();
  if (sl.includes("part"))                              return "Part";
  if (sl.includes("unfurnished") || sl === "no")        return "No";
  if (sl.includes("optional") || sl.includes("either")) return "Optional";
  if (sl.includes("furnished") || sl === "yes")         return "Yes";
  return s;
}

function normaliseListingType(subType: string | null | undefined, students: boolean): string {
  if (students) return "houseshare"; // not actually a houseshare, but room-only listings often hit this
  if (!subType) return "flat";
  const lt = subType.toLowerCase();
  if (/studio/.test(lt))     return "studio";
  if (/house\s*share|hmo/.test(lt)) return "houseshare";
  if (/maisonette/.test(lt)) return "maisonette";
  if (/flat|apartment/.test(lt)) return "flat";
  if (/house|terraced|semi|detached/.test(lt)) return "house";
  return lt;
}

function letDateToIso(d: string | null | undefined): string | null {
  if (!d) return null;
  // Rightmove returns ISO ("2026-08-03T00:00:00Z") for real dates, or
  // "Ask agent" / "Now" for placeholders.
  const iso = d.match(/^\d{4}-\d{2}-\d{2}/);
  if (iso) return iso[0];
  const sl = d.toLowerCase();
  if (sl.includes("now") || sl.includes("immediately")) {
    return new Date().toISOString().slice(0, 10);
  }
  return null;
}

function summaryPreFilter(s: RmSummary): FilterResult {
  if (!s.price?.amount || s.price.frequency !== "monthly") {
    return { pass: false, reason: "no monthly price" };
  }
  if (s.price.amount > MAX_PRICE) {
    return { pass: false, reason: `price £${s.price.amount} > £${MAX_PRICE}` };
  }
  if (s.bedrooms < 1 || s.bedrooms > 2) {
    return { pass: false, reason: `bedrooms ${s.bedrooms} outside 1-2` };
  }
  const out = outcodeFromAddress(s.displayAddress);
  if (!out || !ALLOWED_POSTCODES.has(out)) {
    return { pass: false, reason: `outcode ${out ?? "?"} not allowed` };
  }
  if (s.students) {
    return { pass: false, reason: "students-only" };
  }
  const iso = letDateToIso(s.letAvailableDate);
  if (iso && iso > DEADLINE) {
    return { pass: false, reason: `available ${iso} > deadline` };
  }
  const ds = (s.displayStatus ?? "").toLowerCase();
  if (ds.includes("let agreed") || ds.includes("under offer")) {
    return { pass: false, reason: `status: ${s.displayStatus}` };
  }
  return { pass: true };
}

async function fetchSearchPage(index: number): Promise<{ properties: RmSummary[]; total: number; pages: number } | null> {
  const url = `${SEARCH_BASE}${index > 0 ? `&index=${index}` : ""}`;
  const res = await fetchText(url, { minGapMs: 1500 });
  if (res.status !== 200) return null;
  const data = extractNextData(res.body);
  const sr = data?.props?.pageProps?.searchResults;
  if (!sr?.properties) return null;
  return {
    properties: sr.properties as RmSummary[],
    total:      sr.resultCount ?? 0,
    pages:      sr.pagination?.total ?? 1,
  };
}

function buildFromDetail(id: number, summary: RmSummary, pm: any): ScrapedListing | null {
  const p = pm?.propertyData;
  if (!p) return null;

  // Status check.
  if (p.status?.letAgreed || p.status?.archived) return null;

  const outcode = p.address?.outcode ?? outcodeFromAddress(p.address?.displayAddress ?? summary.displayAddress);
  const incode  = p.address?.incode  ?? null;
  const postcodeFull = outcode && incode ? `${outcode} ${incode}` : null;

  const description = decodeHtml(p.text?.description ?? "") || decodeHtml(summary.summary ?? "") || null;
  const keyFeatures = Array.isArray(p.keyFeatures) ? p.keyFeatures.filter(Boolean).map(String) : [];

  const imageUrls = (p.images ?? [])
    .map((img: any) => img?.url ?? img?.srcUrl ?? null)
    .filter((u: string | null): u is string => !!u)
    .map((u: string) => u.startsWith("http") ? u : `https://media.rightmove.co.uk/${u}`);

  const images = filterImages(imageUrls);

  const lettings = p.lettings ?? {};
  const availIso = letDateToIso(lettings.letAvailableDate);
  const avail    = lettings.letAvailableDate ?? summary.letAvailableDate ?? null;

  const subType = p.propertySubType ?? summary.propertySubType ?? "";
  const listingType = normaliseListingType(subType, !!summary.students);

  const price = summary.price?.amount ?? null;
  if (price == null) return null;

  return {
    address:       p.address?.displayAddress ?? summary.displayAddress,
    price_pcm:     price,
    source_url:    `https://www.rightmove.co.uk/properties/${id}`,
    listing_type:  listingType,
    beds:          p.bedrooms ?? summary.bedrooms ?? null,
    baths:         p.bathrooms ?? summary.bathrooms ?? null,
    furnished:     normaliseFurnish(lettings.furnishType),
    parking:       null, // Rightmove doesn't expose a structured parking flag; key features may mention it.
    epc:           null, // EPC is a PDF; rating not in PAGE_MODEL.
    deposit:       typeof lettings.deposit === "number" ? lettings.deposit : null,
    available:     avail,
    postcode_area: outcode,
    postcode_full: postcodeFull,
    agent_name:    p.customer?.companyName ?? p.customer?.branchName ?? null,
    description,
    key_features:  keyFeatures,
    images,
  };
}

export async function scrapeRightmove(): Promise<ScrapeReport> {
  const report: ScrapeReport = { portal: "rightmove", written: 0, skipped: [], errors: [] };

  // Page 1 to learn total pages.
  let page1;
  try { page1 = await fetchSearchPage(0); }
  catch (err) { report.errors.push(`search page 1: ${(err as Error).message}`); return report; }
  if (!page1) { report.errors.push("search page 1: no NEXT_DATA"); return report; }

  const allSummaries: RmSummary[] = [...page1.properties];
  const totalPages = page1.pages;

  for (let pg = 2; pg <= totalPages; pg++) {
    const idx = (pg - 1) * PAGE_SIZE;
    try {
      const p = await fetchSearchPage(idx);
      if (p) allSummaries.push(...p.properties);
    } catch (err) {
      report.errors.push(`search page ${pg}: ${(err as Error).message}`);
    }
  }

  // De-duplicate by id (paid placements can repeat).
  const byId = new Map<number, RmSummary>();
  for (const s of allSummaries) if (!byId.has(s.id)) byId.set(s.id, s);

  // Pre-filter on summary data — only fetch detail for survivors.
  const survivors: RmSummary[] = [];
  for (const s of byId.values()) {
    const f = summaryPreFilter(s);
    if (!f.pass) report.skipped.push({ id: s.id, reason: f.reason });
    else survivors.push(s);
  }

  const listings: ScrapedListing[] = [];
  for (const s of survivors) {
    let res;
    try {
      res = await fetchText(`https://www.rightmove.co.uk/properties/${s.id}`, {
        minGapMs: 1500,
        referer: SEARCH_BASE,
      });
    } catch (err) {
      report.errors.push(`detail ${s.id}: ${(err as Error).message}`);
      continue;
    }
    if (res.status !== 200) {
      report.skipped.push({ id: s.id, reason: `HTTP ${res.status}` });
      continue;
    }
    const pm = extractPageModel(res.body);
    if (!pm) {
      report.skipped.push({ id: s.id, reason: "PAGE_MODEL parse failed" });
      continue;
    }
    const built = buildFromDetail(s.id, s, pm);
    if (!built) {
      report.skipped.push({ id: s.id, reason: "let agreed / archived / no price" });
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

  writeResults("rightmove", listings);
  report.written = listings.length;
  return report;
}
