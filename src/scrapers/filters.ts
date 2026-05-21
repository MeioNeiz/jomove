/**
 * Hard filters from `.claude/commands/scrape.md`. Returns
 * `{ pass: true }` or `{ pass: false, reason: "..." }` so the caller
 * can log skip reasons.
 */

import type { Listing } from "../types.ts";
import { DEADLINE } from "../config.ts";

export const MAX_PRICE = 1150;
export const MIN_BEDS  = 1;
export const MAX_BEDS  = 2;
export const ALLOWED_POSTCODES = new Set(["SO14", "SO15", "SO17", "SO18"]);

export type FilterResult = { pass: true } | { pass: false; reason: string };

export function filterPrice(price: number | null | undefined): FilterResult {
  if (price == null) return { pass: false, reason: "no price" };
  if (price > MAX_PRICE) return { pass: false, reason: `price £${price} > £${MAX_PRICE}` };
  return { pass: true };
}

export function filterBeds(beds: number | null | undefined, type: string | null): FilterResult {
  // Studios count as 1 bed per the scrape brief.
  const isStudio = (type ?? "").toLowerCase() === "studio";
  const effective = beds ?? (isStudio ? 1 : null);
  if (effective == null) return { pass: false, reason: "no bed count" };
  if (effective < MIN_BEDS || effective > MAX_BEDS) {
    return { pass: false, reason: `beds=${effective} outside ${MIN_BEDS}-${MAX_BEDS}` };
  }
  return { pass: true };
}

export function filterPostcode(area: string | null | undefined): FilterResult {
  if (!area) return { pass: false, reason: "no postcode area" };
  const norm = area.toUpperCase().trim();
  if (!ALLOWED_POSTCODES.has(norm)) {
    return { pass: false, reason: `postcode ${norm} not in allow-list` };
  }
  return { pass: true };
}

/** "Available by 6 July 2026 (or sooner / immediately)." */
export function filterAvailable(iso: string | null | undefined): FilterResult {
  if (!iso) return { pass: true }; // unknown → don't reject, just flag
  if (iso > DEADLINE) {
    return { pass: false, reason: `available ${iso} > deadline ${DEADLINE}` };
  }
  return { pass: true };
}

const STATUS_KILL = [
  /\blet agreed\b/i,
  /\bunder offer\b/i,
  /\bno longer available\b/i,
  /\bhas been let\b/i,
];

/** Surface text from title/description that suggests the listing is dead. */
export function filterAlive(haystack: string): FilterResult {
  for (const re of STATUS_KILL) {
    if (re.test(haystack)) return { pass: false, reason: `matched /${re.source}/` };
  }
  return { pass: true };
}

const STUDENT_KILL = [
  /students? only/i,
  /must be enrolled/i,
  /university accommodation only/i,
];

export function filterNotStudentOnly(haystack: string): FilterResult {
  for (const re of STUDENT_KILL) {
    if (re.test(haystack)) return { pass: false, reason: `student-only (/${re.source}/)` };
  }
  return { pass: true };
}

/** Apply every filter; first failure wins. */
export function filterListing(
  l: Pick<Listing, "price_pcm" | "beds" | "postcode_area" | "available_date" | "listing_type" | "description" | "address">,
): FilterResult {
  const checks: FilterResult[] = [
    filterPrice(l.price_pcm),
    filterBeds(l.beds, l.listing_type),
    filterPostcode(l.postcode_area),
    filterAvailable(l.available_date),
    filterAlive(`${l.address}\n${l.description ?? ""}`),
    filterNotStudentOnly(`${l.address}\n${l.description ?? ""}`),
  ];
  for (const c of checks) if (!c.pass) return c;
  return { pass: true };
}
