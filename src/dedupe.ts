/**
 * Address normalisation for cross-portal duplicate detection.
 *
 * Same flat listed on Rightmove, OnTheMarket and OpenRent will have
 * three slightly different address strings:
 *   Rightmove:   "|Ref: R153042|, Shirley Road, Southampton, SO15 3EY"
 *   OnTheMarket: "Shirley Road, Southampton SO15"
 *   OpenRent:    "Flat 2, Shirley Road, Southampton"
 * `dedupeKey` strips the noise (ref-codes, unit numbers, "Southampton",
 * postcodes, abbreviation differences) so the three collapse into one
 * group keyed on `<street> | <area> | <price>`.
 */

const REF_BLOCK_RE   = /^\|[^|]*\|\s*,?\s*/;   // "|Ref: R12345|, " prefix
const UNIT_PREFIX_RE = /^\s*(?:\d+\s*bed\s*(?:flat|apartment|maisonette|house|studio)\s*,?\s*|flat\s+\w+\s*,?\s*|apartment\s+\w+\s*,?\s*|apt\s+\w+\s*,?\s*)/i;
const LEADING_NUM_RE = /^\s*\d+[a-z]?\s+/i;     // "12 Portswood Road" → "Portswood Road"

// Map "road" → "rd", "street" → "st", etc., so Rightmove/OnTheMarket spelling
// differences don't split otherwise-identical streets into two groups.
const SUFFIX_NORM: Array<[RegExp, string]> = [
  [/\broad\b\.?/g,     "rd"],
  [/\bstreet\b\.?/g,   "st"],
  [/\bavenue\b\.?/g,   "ave"],
  [/\bplace\b\.?/g,    "pl"],
  [/\bcrescent\b\.?/g, "cres"],
  [/\bsquare\b\.?/g,   "sq"],
  [/\bterrace\b\.?/g,  "ter"],
  [/\bclose\b\.?/g,    "cl"],
  [/\bgardens?\b\.?/g, "gdns"],
  [/\bdrive\b\.?/g,    "dr"],
  [/\blane\b\.?/g,     "ln"],
  [/\bcourt\b\.?/g,    "ct"],
];

/**
 * Best-effort cross-portal dedupe key.
 *
 * Returns `<normalised-street> | <postcode-area> | <price>`. Same flat
 * across portals matches even when the unit number, agent ref or
 * "Road" vs "Rd" differs. Different prices stay distinct (e.g. an
 * agent dropped the asking price → treat as a new appearance).
 */
export function dedupeKey(address: string, price: number, postcodeArea: string | null): string {
  let a = address.toLowerCase();

  // Drop opening "|Ref: R12345|, " block (Rightmove agent refs).
  a = a.replace(REF_BLOCK_RE, "");

  // Strip "1 bed flat, " / "Flat 3, " / "Apt B, " portal-specific prefixes.
  a = a.replace(UNIT_PREFIX_RE, "");

  // Trim trailing ", Southampton" and ", Hampshire" before postcode normalisation.
  a = a.replace(/,?\s*southampton\s*,?/i, "");
  a = a.replace(/,?\s*hampshire\s*,?/i, "");
  // Remove trailing postcode (full or area-only).
  a = a.replace(/,?\s*so\d{1,2}\s*\d?[a-z]{0,2}\s*$/i, "");

  // Take just the first segment — usually the street name itself.
  let chunk = a.split(",")[0]!.trim().replace(/^,+|,+$/g, "").trim();

  // Strip leading house number — most cross-portal duplicates differ only
  // in whether they put "12 " in front of the street name.
  chunk = chunk.replace(LEADING_NUM_RE, "").trim();

  // Apply street-type abbreviations after lowercasing.
  for (const [re, repl] of SUFFIX_NORM) chunk = chunk.replace(re, repl);

  // Collapse whitespace, strip stray punctuation that often differs.
  chunk = chunk
    .replace(/[.’']/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return `${chunk}|${postcodeArea ?? ""}|${price}`;
}

const DIRECT_STATIONS = ["central", "st denys", "swaythling", "airport parkway"] as const;

/** 1 if the rail field implies a direct Central ↔ Airport Parkway route, else 0. */
export function directLine(rail: string | undefined): number {
  if (!rail) return 0;
  const t = rail.toLowerCase();
  if (t.includes("not direct") || t.includes("netley") ||
      t.includes("requires change") || t.includes("needs a change")) return 0;
  if (t.includes("not on") && t.includes("direct")) return 0;
  return DIRECT_STATIONS.some(s => t.includes(s)) ? 1 : 0;
}
