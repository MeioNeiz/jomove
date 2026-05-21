import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { connect } from "../db.ts";
import { parseFile } from "../markdown.ts";
import { SOURCES, ROOT } from "../config.ts";
import { ensurePostcodeGeocodes, runAddressGeocoding } from "../geocode.ts";
import { nowIso } from "../util/now.ts";
import { bumpDataVersion } from "../payload.ts";
import type { Listing } from "../types.ts";

type FileTarget = { path: string; source: string };

// bun:sqlite matches named parameters more reliably when binds carry the `$`
// prefix — without it, `$source` and `$source_url` can collide. The return
// type is widened to `any` so it satisfies bun:sqlite's strict binding type
// (the runtime accepts the named-params object form, but @types/bun doesn't
// expose that overload).
function dollar(obj: Record<string, unknown>): any {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    // image_urls + key_features are string[] on Listing; SQLite stores as JSON text.
    if (k === "image_urls" || k === "key_features") {
      const arr = Array.isArray(v) ? v as string[] : [];
      out[`$${k}`] = arr.length > 0 ? JSON.stringify(arr) : null;
    } else {
      out[`$${k}`] = v;
    }
  }
  return out;
}

function resolveTargets(paths: string[]): FileTarget[] {
  const targets: FileTarget[] = [];
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(ROOT, p);
    if (!existsSync(abs)) {
      console.warn(`Skipped (not found): ${p}`);
      continue;
    }
    if (statSync(abs).isDirectory()) {
      for (const [fname, source] of Object.entries(SOURCES)) {
        const fp = join(abs, fname);
        if (existsSync(fp)) targets.push({ path: fp, source });
      }
    } else {
      const source = SOURCES[basename(abs)];
      if (!source) {
        console.warn(`Unrecognised file (no source mapping): ${basename(abs)}`);
        continue;
      }
      targets.push({ path: abs, source });
    }
  }
  return targets;
}

// Single statement with ON CONFLICT(source_url) UPSERT semantics so the
// two-statement (find/insert vs update) skew risk disappears.
//
// We need:
//   - first_seen: keep the original on conflict (use COALESCE so NULL maps
//     to existing value)
//   - image_url / image_urls / listing_type / description / key_features /
//     agent_name: keep the existing value if the new row didn't supply one
//     (older scrapers don't fill every field). Achieved via COALESCE on
//     excluded.value against the existing row.
const UPSERT_SQL = `
INSERT INTO listings (
  source, source_url, address, price_pcm, beds, baths,
  furnished_raw, furnished_status, parking_raw, parking_status, epc, deposit,
  available_raw, available_date, postcode_area, postcode_full, neighbourhood,
  near_green_space, rail_access, on_direct_line, why_worth_a_look, caveats,
  dedupe_key, image_url, image_urls, listing_type,
  description, key_features, agent_name,
  first_seen, last_seen
) VALUES (
  $source, $source_url, $address, $price_pcm, $beds, $baths,
  $furnished_raw, $furnished_status, $parking_raw, $parking_status, $epc, $deposit,
  $available_raw, $available_date, $postcode_area, $postcode_full, $neighbourhood,
  $near_green_space, $rail_access, $on_direct_line, $why_worth_a_look, $caveats,
  $dedupe_key, $image_url, $image_urls, $listing_type,
  $description, $key_features, $agent_name,
  $first_seen, $last_seen
)
ON CONFLICT(source_url) DO UPDATE SET
  address          = excluded.address,
  price_pcm        = excluded.price_pcm,
  beds             = excluded.beds,
  baths            = excluded.baths,
  furnished_raw    = excluded.furnished_raw,
  furnished_status = excluded.furnished_status,
  parking_raw      = excluded.parking_raw,
  parking_status   = excluded.parking_status,
  epc              = excluded.epc,
  deposit          = excluded.deposit,
  available_raw    = excluded.available_raw,
  available_date   = excluded.available_date,
  postcode_area    = excluded.postcode_area,
  postcode_full    = excluded.postcode_full,
  neighbourhood    = excluded.neighbourhood,
  near_green_space = excluded.near_green_space,
  rail_access      = excluded.rail_access,
  on_direct_line   = excluded.on_direct_line,
  why_worth_a_look = excluded.why_worth_a_look,
  caveats          = excluded.caveats,
  dedupe_key       = excluded.dedupe_key,
  image_url        = COALESCE(excluded.image_url,    listings.image_url),
  image_urls       = COALESCE(excluded.image_urls,   listings.image_urls),
  listing_type     = COALESCE(excluded.listing_type, listings.listing_type),
  description      = COALESCE(excluded.description,  listings.description),
  key_features     = COALESCE(excluded.key_features, listings.key_features),
  agent_name       = COALESCE(excluded.agent_name,   listings.agent_name),
  last_seen        = excluded.last_seen
`;

export type IngestStats = { inserted: number; updated: number };

/**
 * Direct-ingest path. Used by both the markdown-file route (cmdIngest) and
 * by auto-scrape, which has typed listings in memory already and shouldn't
 * have to roundtrip through markdown just to be parsed back.
 *
 * Returns { inserted, updated }. The caller decides whether to run the
 * geocoder afterwards.
 */
export function ingestListings(db: Database, listings: Listing[]): IngestStats {
  const now = nowIso();
  const findStmt = db.query("SELECT id FROM listings WHERE source_url = ?");
  const upsertStmt = db.query(UPSERT_SQL);

  let inserted = 0, updated = 0;
  const tx = db.transaction((rows: Listing[]) => {
    for (const L of rows) {
      const exists = findStmt.get(L.source_url);
      upsertStmt.run(dollar({ ...L, first_seen: now, last_seen: now }));
      if (exists) updated++; else inserted++;
    }
  });
  tx(listings);

  if (inserted + updated > 0) bumpDataVersion(db, now);
  return { inserted, updated };
}

export async function cmdIngest(paths: string[]): Promise<void> {
  const targets = resolveTargets(paths);
  if (targets.length === 0) {
    console.warn("No matching results_*.md files found. Pass a directory or files explicitly.");
    return;
  }

  const db = connect();
  try {
    const allListings: Listing[] = [];
    for (const { path, source } of targets) {
      allListings.push(...parseFile(path, source));
    }

    const { inserted, updated } = ingestListings(db, allListings);
    console.log(`Ingest done: ${inserted} new, ${updated} updated (${targets.length} source files)`);

    // Geocode synchronously so every scrape leaves the DB ready-to-serve.
    // postcodes.io batch is fast (1 round-trip / 100 postcodes); Photon +
    // Nominatim address fallback is slow but bounded to one pass per new
    // address, and the cache makes re-runs cheap.
    try {
      await ensurePostcodeGeocodes(db);
      await runAddressGeocoding(db);
    } catch (err) {
      console.warn("Geocoding pass errored:", err);
    }
  } finally {
    db.close();
  }
}
