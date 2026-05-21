/**
 * Adapter: `ScrapedListing` (whatever a portal scraper produces) →
 * canonical `Listing` shape that ingest.ts writes to SQLite.
 *
 * Keeps the scrapers ignorant of dedupe keys, direct-line flags, and
 * field-status canonicalisation, and removes the markdown roundtrip
 * for the auto-scrape path. The markdown writer (output.ts) still
 * exists for archive/AI flow.
 */

import type { Listing } from "../types.ts";
import type { ScrapedListing } from "./output.ts";
import { dedupeKey, directLine } from "../dedupe.ts";
import {
  parseFurnished, parseParking, parseEpc, parseDeposit, parseAvailable,
  parsePostcodeArea, parsePostcodeFull, parseListingType,
} from "../field-parsers.ts";

export function toListing(source: string, s: ScrapedListing): Listing {
  const furnishedRaw = s.furnished ?? "";
  const parkingRaw   = s.parking ?? "";
  const avail        = parseAvailable(s.available ?? "");
  // Postcode area/full might be already canonical from the scraper, but fall
  // back to parser so a portal that doesn't return them still benefits.
  const postcodeArea = s.postcode_area ?? parsePostcodeArea(
    `${s.postcode_full ?? ""} ${s.address}`,
  );
  const postcodeFull = s.postcode_full ?? parsePostcodeFull(
    `${s.postcode_full ?? ""} ${s.address}`,
  );
  const images = s.images ?? [];

  return {
    source,
    source_url:       s.source_url,
    address:          s.address,
    price_pcm:        s.price_pcm,
    beds:             s.beds ?? null,
    baths:            s.baths ?? null,
    furnished_raw:    furnishedRaw,
    furnished_status: parseFurnished(furnishedRaw),
    parking_raw:      parkingRaw,
    parking_status:   parseParking(parkingRaw),
    epc:              s.epc ?? parseEpc(""),
    deposit:          s.deposit ?? parseDeposit(""),
    available_raw:    avail.raw,
    available_date:   avail.iso,
    postcode_area:    postcodeArea,
    postcode_full:    postcodeFull,
    neighbourhood:    postcodeArea ?? "",
    near_green_space: "",
    rail_access:      "",
    on_direct_line:   directLine(undefined),
    why_worth_a_look: "",
    caveats:          "",
    dedupe_key:       dedupeKey(s.address, s.price_pcm, postcodeArea),
    image_url:        images[0] ?? null,
    image_urls:       images,
    listing_type:     s.listing_type ?? parseListingType(s.address),
    description:      s.description ?? null,
    key_features:     s.key_features ?? [],
    agent_name:       s.agent_name ?? null,
  };
}
