/**
 * Gumtree scraper.
 *
 * Discovery: search at `/flats-houses/property-to-rent/uk/southampton`
 * — iterate `/pageN` until a page has no new IDs. Each card is
 * `<a href="/p/property-to-rent/{slug}/{id}">`.
 *
 * Detail: JSON-LD `RealEstateListing` carries title, price, full
 * description, image array, seller name. Beds + property type are
 * parsed from the title. Postcode (if any) is regex-extracted from
 * the description body — Gumtree doesn't expose it as a meta tag.
 *
 * Caveats:
 *  - Pagination drops some filter params; we re-filter client-side.
 *  - Promoted/sponsored listings appear on multiple pages — de-dup.
 *  - Some listings are weekly-priced (£X pw); convert to PCM.
 */

import { fetchText } from "./http.ts";
import { writeResults, type ScrapedListing } from "./output.ts";
import { filterListing, type FilterResult, MAX_PRICE, ALLOWED_POSTCODES } from "./filters.ts";
import { filterImages } from "./images.ts";
import { parseAvailable } from "../field-parsers.ts";
import type { ScrapeReport } from "./registry.ts";
export type { ScrapeReport } from "./registry.ts";

const SEARCH_BASE_PATH = "/flats-houses/property-to-rent/uk/southampton";
const SEARCH_HOST      = "https://www.gumtree.com";
const SEARCH_QUERY     = "?max_price=1150&min_bedrooms=1&max_bedrooms=2";

const HOST_GAP_MS = 1500;
const MAX_PAGES   = 20;

function decodeHtml(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&pound;/gi, "£")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

type GumtreeCard = {
  id:        string;
  title:     string;
  price:     number | null;
  location:  string;
};

/**
 * Pull cards out of the search HTML with enough data to pre-filter
 * before fetching detail pages. Walks anchors and grabs the data-q
 * fields inside each card.
 */
function extractCards(html: string): GumtreeCard[] {
  const out: GumtreeCard[] = [];
  const anchorRe = /href=["']\/p\/property-to-rent\/[\w-]+\/(\d{10,})["'][\s\S]{0,12000}?<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const id = m[1]!;
    const card = m[0]!;

    const title = card.match(/data-q=["']tile-title["'][^>]*>([\s\S]*?)<\//)?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "";
    const priceText = card.match(/data-q=["']tile-price["'][^>]*>([\s\S]*?)<\//)?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "";
    const location  = card.match(/data-q=["']tile-location["'][^>]*>([\s\S]*?)<\//)?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "";

    const priceM = priceText.match(/£([\d,]+)/);
    let price = priceM ? parseInt(priceM[1]!.replace(/,/g, ""), 10) : null;
    if (price != null && /p\/?w\b|per\s+week/i.test(priceText)) price = Math.round(price * 52 / 12);

    out.push({ id, title: decodeHtml(title), price, location: decodeHtml(location) });
  }
  // De-dup by id (sponsored slots repeat).
  const byId = new Map<string, GumtreeCard>();
  for (const c of out) if (!byId.has(c.id)) byId.set(c.id, c);
  return [...byId.values()];
}

/**
 * Decide whether a card is worth a detail fetch. Cheap, never wrong:
 * if we can definitively rule it out from the visible card, skip.
 */
function cardPreFilter(c: GumtreeCard): FilterResult {
  if (c.price != null && c.price > MAX_PRICE) {
    return { pass: false, reason: `card price £${c.price} > £${MAX_PRICE}` };
  }
  const t = parseTitle(c.title);
  // The Southampton search returns surrounding-area listings (Romsey,
  // Eastleigh, …). If the location string has an outcode we recognise
  // outside our allow-list, skip.
  const out = c.location.match(/\bSO\d{1,2}\b/i)?.[0]?.toUpperCase();
  if (out && !ALLOWED_POSTCODES.has(out)) {
    return { pass: false, reason: `card outcode ${out} not allowed` };
  }
  // Bed count over 2 is an immediate skip.
  if (t.beds != null && t.beds > 2) {
    return { pass: false, reason: `card beds ${t.beds} > 2` };
  }
  return { pass: true };
}

function extractJsonLd(html: string, type: string): any | null {
  const blocks = [...html.matchAll(/<script type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    try {
      const j = JSON.parse(b[1]!);
      const t = j["@type"];
      if (Array.isArray(t) ? t.includes(type) : t === type) return j;
    } catch { /* swallow */ }
  }
  return null;
}

function parseTitle(title: string): { beds: number | null; listingType: string } {
  // Examples:
  //   "3 bed flat in overlap of Bassett & Chilworth"
  //   "Studio flat to rent in Southampton"
  //   "Double room in shared house"
  //   "2 bed apartment Portswood"
  const t = decodeHtml(title);
  const bedsM = t.match(/^(\d+)\s+bed(?:room)?\b/i);
  const beds = bedsM ? parseInt(bedsM[1]!, 10) : null;

  const lt = t.toLowerCase();
  let listingType = "flat";
  // Word-boundary `\broom\b` matters — without it "bedroom" matches.
  if (/studio/.test(lt))                             listingType = "studio";
  else if (/\b(room|hmo|house\s*share|shared\s+(?:house|flat))\b/.test(lt)) listingType = "houseshare";
  else if (/maisonette/.test(lt))                    listingType = "maisonette";
  else if (/flat|apartment/.test(lt))                listingType = "flat";
  else if (/house|terraced|semi|detached|bungalow/.test(lt)) listingType = "house";
  return { beds, listingType };
}

function normalisePcm(priceStr: string | number, body: string): number | null {
  const raw = typeof priceStr === "number" ? priceStr : parseFloat(String(priceStr).replace(/[^\d.]/g, ""));
  if (!raw || Number.isNaN(raw)) return null;
  // Detect price frequency. JSON-LD doesn't always give us a unit, so
  // sniff the page body for "pw" vs "pcm" near the price.
  const isWeekly = /£[\d,]+(?:\.\d{2})?\s*p\/?w\b|per\s+week/i.test(body);
  if (isWeekly) return Math.round(raw * 52 / 12);
  return Math.round(raw);
}

function parsePostcode(s: string): { area: string | null; full: string | null } {
  // Match both "SO14 7DR" and the spaceless "SO147DR" form.
  const m = s.match(/\b(SO\d{1,2})\s*(\d[A-Z]{2})\b/i);
  if (m) return { area: m[1]!.toUpperCase(), full: `${m[1]!.toUpperCase()} ${m[2]!.toUpperCase()}` };
  const areaM = s.match(/\b(SO\d{1,2})\b/i);
  return { area: areaM ? areaM[1]!.toUpperCase() : null, full: null };
}

function parseFurnishedFromDescription(desc: string): string | null {
  const sl = desc.toLowerCase();
  if (sl.includes("part furnished") || sl.includes("part-furnished")) return "Part";
  if (sl.includes("furnished") && sl.includes("unfurnished"))         return "Optional";
  if (sl.includes("furnished"))                                       return "Yes";
  if (sl.includes("unfurnished"))                                     return "No";
  return null;
}

function parseParkingFromDescription(desc: string): string | null {
  const sl = desc.toLowerCase();
  if (sl.includes("allocated parking"))   return "allocated";
  if (sl.includes("driveway"))            return "driveway";
  if (sl.includes("off-street parking") || sl.includes("off street parking")) return "off-street";
  if (sl.includes("permit parking"))      return "permit";
  if (sl.includes("on-street parking") || sl.includes("on street parking"))   return "on-street";
  if (sl.includes("no parking"))          return "none";
  if (sl.includes("parking"))             return "unclear";
  return null;
}

function parseEpcFromDescription(desc: string): string | null {
  const m = desc.match(/\bEPC\b[^A-G]{0,15}\b([A-G])\b/i);
  return m ? m[1]!.toUpperCase() : null;
}

async function fetchPage(pageNum: number): Promise<GumtreeCard[] | null> {
  const url = pageNum <= 1
    ? `${SEARCH_HOST}${SEARCH_BASE_PATH}${SEARCH_QUERY}`
    : `${SEARCH_HOST}${SEARCH_BASE_PATH}/page${pageNum}${SEARCH_QUERY}`;
  const res = await fetchText(url, { minGapMs: HOST_GAP_MS });
  if (res.status !== 200) return null;
  return extractCards(res.body);
}

function buildListing(id: string, ld: any, body: string): ScrapedListing | null {
  const me = ld?.mainEntity;
  if (!me) return null;

  const title = decodeHtml(me.name ?? "");
  const descRaw = decodeHtml(me.description ?? "");
  const t = parseTitle(title);

  const offers = me.offers ?? {};
  const price = normalisePcm(offers.price ?? 0, body);
  if (price == null) return null;

  const seller = offers.offeredBy?.name ?? null;

  // Image list — JSON-LD often gives one URL or an array.
  const rawImages = Array.isArray(me.image) ? me.image : (me.image ? [me.image] : []);
  const images = filterImages(rawImages.filter((u: any): u is string => typeof u === "string"));

  const pc = parsePostcode(descRaw + " " + title);
  const furnished = parseFurnishedFromDescription(descRaw);
  const parking   = parseParkingFromDescription(descRaw);
  const epc       = parseEpcFromDescription(descRaw);

  // Available date — usually buried in the description. Stop at the
  // first ~30 chars or at obvious break tokens (period, newline,
  // semicolon, multi-space block, "Rent:", "Deposit:", etc).
  const availMatch = descRaw.match(/(?:available|move[\s-]in)\s*(?:from\s+)?[:\s]+([^.\n;]{1,40}?)(?=\s*(?:\.|\n|;|\s{2,}|Rent\b|Deposit\b|Bills\b|£))/i);
  const available = availMatch ? availMatch[1]!.trim() : null;

  const featuresBlock = descRaw.match(/(?:^|\n)\s*key\s*features?\s*:?([\s\S]+?)(?=\n\n|\n[A-Z][a-z]+\s*:|$)/i)?.[1] ?? "";
  const keyFeatures = featuresBlock
    .split(/[\n\r]+/)
    .map(l => l.replace(/^[-*•✅✔️🟢]+\s*/u, "").trim())
    .filter(l => l.length > 2 && l.length < 120)
    .slice(0, 15);

  // Address: Gumtree titles include neighbourhood. Build a workable address.
  const address = title.replace(/\s+\|\s.*$/, "").trim();

  return {
    address:        address.length > 0 ? `${address}, Southampton` : "Southampton",
    price_pcm:      price,
    source_url:     `${SEARCH_HOST}/p/property-to-rent/${id}/${id}`.replace(/\/\d+\/\d+$/, `/${id}`),
    listing_type:   t.listingType,
    beds:           t.beds,
    baths:          null,
    furnished,
    parking,
    epc,
    deposit:        null,
    available,
    postcode_area:  pc.area,
    postcode_full:  pc.full,
    agent_name:     seller,
    description:    descRaw || null,
    key_features:   keyFeatures,
    images,
  };
}

export async function scrapeGumtree(): Promise<ScrapeReport> {
  const report: ScrapeReport = {
    portal: "gumtree", written: 0, skipped: [], errors: [], listings: [],
  };

  // Collect cards across pages, with card-level pre-filter.
  const cardsById = new Map<string, GumtreeCard>();
  for (let pg = 1; pg <= MAX_PAGES; pg++) {
    let cards;
    try { cards = await fetchPage(pg); }
    catch (err) {
      report.errors.push(`search page ${pg}: ${(err as Error).message}`);
      continue;
    }
    if (!cards) {
      report.errors.push(`search page ${pg}: non-200 or unparseable`);
      break;
    }
    const before = cardsById.size;
    for (const c of cards) if (!cardsById.has(c.id)) cardsById.set(c.id, c);
    if (cardsById.size === before && pg >= 2) break;
  }

  const survivors: GumtreeCard[] = [];
  for (const c of cardsById.values()) {
    const f = cardPreFilter(c);
    if (!f.pass) report.skipped.push({ id: c.id, reason: f.reason });
    else survivors.push(c);
  }

  const listings: ScrapedListing[] = [];
  for (const c of survivors) {
    const id = c.id;
    const url = `${SEARCH_HOST}/p/property-to-rent/_/${id}`;
    // Note: Gumtree accepts the {id} alone too; the slug is for SEO.
    let res;
    try {
      res = await fetchText(url, { minGapMs: HOST_GAP_MS, referer: `${SEARCH_HOST}${SEARCH_BASE_PATH}` });
    } catch (err) {
      report.errors.push(`detail ${id}: ${(err as Error).message}`);
      continue;
    }
    if (res.status !== 200) {
      report.skipped.push({ id, reason: `HTTP ${res.status}` });
      continue;
    }
    const ld = extractJsonLd(res.body, "RealEstateListing");
    if (!ld) {
      report.skipped.push({ id, reason: "no JSON-LD RealEstateListing" });
      continue;
    }
    const built = buildListing(id, ld, res.body);
    if (!built) {
      report.skipped.push({ id, reason: "unparseable" });
      continue;
    }
    // Use the final URL Gumtree redirected us to as the canonical link.
    built.source_url = res.url;

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
    if (!f.pass) {
      report.skipped.push({ id, reason: f.reason });
      continue;
    }
    listings.push(built);
  }

  writeResults("gumtree", listings);
  report.written = listings.length;
  report.listings = listings;
  return report;
}
