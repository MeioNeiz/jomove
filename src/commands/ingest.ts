import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { connect } from "../db.ts";
import { parseFile } from "../markdown.ts";
import { SOURCES, ROOT } from "../config.ts";
import { ensurePostcodeGeocodes, runAddressGeocoding } from "../geocode.ts";

type FileTarget = { path: string; source: string };

// bun:sqlite matches named parameters more reliably when binds carry the `$`
// prefix — without it, `$source` and `$source_url` can collide.
function dollar(obj: Record<string, unknown>): Record<string, unknown> {
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

export async function cmdIngest(paths: string[]): Promise<void> {
  const targets = resolveTargets(paths);
  if (targets.length === 0) {
    console.warn("No matching results_*.md files found. Pass a directory or files explicitly.");
    return;
  }

  const db = connect();
  const now = new Date().toISOString().slice(0, 19);

  const findStmt = db.query("SELECT id FROM listings WHERE source_url = ?");
  const updateStmt = db.query(`UPDATE listings SET
    address = $address, price_pcm = $price_pcm, beds = $beds, baths = $baths,
    furnished_raw = $furnished_raw, furnished_status = $furnished_status,
    parking_raw = $parking_raw, parking_status = $parking_status,
    epc = $epc, deposit = $deposit, available_raw = $available_raw,
    available_date = $available_date, postcode_area = $postcode_area,
    postcode_full = $postcode_full, neighbourhood = $neighbourhood,
    near_green_space = $near_green_space, rail_access = $rail_access,
    on_direct_line = $on_direct_line, why_worth_a_look = $why_worth_a_look,
    caveats = $caveats, dedupe_key = $dedupe_key,
    image_url = COALESCE($image_url, image_url),
    image_urls = COALESCE($image_urls, image_urls),
    listing_type = COALESCE($listing_type, listing_type),
    description = COALESCE($description, description),
    key_features = COALESCE($key_features, key_features),
    agent_name = COALESCE($agent_name, agent_name),
    last_seen = $last_seen
    WHERE source_url = $source_url`);
  const insertStmt = db.query(`INSERT INTO listings (
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
  )`);

  let inserted = 0, updated = 0;
  for (const { path, source } of targets) {
    for (const L of parseFile(path, source)) {
      const exists = findStmt.get(L.source_url);
      if (exists) {
        updateStmt.run(dollar({ ...L, last_seen: now }));
        updated++;
      } else {
        insertStmt.run(dollar({ ...L, first_seen: now, last_seen: now }));
        inserted++;
      }
    }
  }
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
  } finally {
    db.close();
  }
}
