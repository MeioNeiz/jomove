import type { Database } from "bun:sqlite";
import { nowIso } from "./util/now.ts";

/**
 * Generic geocode cache: query (postcode or address) → lat/lon.
 * `source` tracks which API resolved it ('postcodes.io' | 'nominatim').
 * `status` is 'ok' or 'not_found' so failures don't get retried every request.
 */
export const GEOCODE_SCHEMA = `
CREATE TABLE IF NOT EXISTS geocode (
  query      TEXT PRIMARY KEY,
  lat        REAL,
  lon        REAL,
  status     TEXT NOT NULL,
  source     TEXT,
  fetched_at TEXT NOT NULL
);
`;

// Photon (komoot.io) is the preferred primary because its rate limits are
// friendlier (≥3 req/s tolerated) and it returns the same OSM data as
// Nominatim. When Photon is reachable we use it as pass 1 and Nominatim as
// the fallback for misses (Nominatim has stronger UK street-level coverage
// in practice). When Photon is down — as it occasionally is — we skip
// straight to Nominatim-only at its 1 req/s ToS rate.
const PHOTON_DELAY_MS    = 350;
const PHOTON_PROBE_MS    = 5000;
const NOMINATIM_DELAY_MS = 1200;
const NOMINATIM_UA       = "jomove-rental-tracker/1.0 (personal-use)";
let _bgRunning = false;

/**
 * Postcodes that haven't been geocoded yet → batch via api.postcodes.io.
 * Postcodes.io supports 100 per request and has no rate limit for low volume,
 * so this is safe to call on every page render.
 */
export async function ensurePostcodeGeocodes(db: Database): Promise<void> {
  const rows = db.query(`
    SELECT DISTINCT postcode_full AS pc
    FROM listings
    WHERE postcode_full IS NOT NULL
      AND postcode_full != ''
      AND postcode_full NOT IN (SELECT query FROM geocode)
  `).all() as Array<{ pc: string }>;
  if (rows.length === 0) return;

  const postcodes = rows.map(r => r.pc);
  const upsert = upsertStmt(db);
  const now = nowIso();

  for (let i = 0; i < postcodes.length; i += 100) {
    const chunk = postcodes.slice(i, i + 100);
    try {
      const res = await fetch("https://api.postcodes.io/postcodes", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ postcodes: chunk }),
      });
      if (!res.ok) {
        console.warn(`geocode: postcodes.io returned ${res.status}`);
        continue;
      }
      const body = await res.json() as {
        result: Array<{
          query:  string;
          result: { latitude: number; longitude: number } | null;
        }>;
      };
      for (const r of body.result ?? []) {
        const ok = r.result != null;
        upsert.run({
          $query:      r.query,
          $lat:        ok ? r.result!.latitude  : null,
          $lon:        ok ? r.result!.longitude : null,
          $status:     ok ? "ok" : "not_found",
          $source:     "postcodes.io",
          $fetched_at: now,
        });
      }
    } catch (err) {
      console.warn("geocode: postcodes.io fetch failed:", err);
    }
  }
}

type LatLon = { lat: number; lon: number };

/**
 * Address-based geocoding. Awaitable — caller blocks until done. Only
 * processes listings without a precise full postcode hit cached already.
 *
 * Strategy:
 *  1. Probe Photon once. If reachable, use it as pass 1 (fast) and
 *     Nominatim as pass 2 for Photon's misses.
 *  2. If Photon is unreachable (the API has had outages), skip straight
 *     to a Nominatim-only pass at 1 req/s. Slower but doesn't strand
 *     listings waiting for an API that may stay down.
 *
 * Network errors are NOT cached as `not_found` so a later run can retry
 * once the API recovers. Only genuine "no result" responses are cached.
 *
 * This is the workhorse: used both by `ingest` (synchronously, so a fresh
 * scrape leaves the DB ready) and by `kickoffAddressGeocodingBackground`
 * (fire-and-forget, latched, used by the dev server).
 */
export async function runAddressGeocoding(db: Database): Promise<void> {
  const candidates = db.query(`
    SELECT DISTINCT address || ', Southampton, UK' AS q
    FROM listings
    WHERE (postcode_full IS NULL OR postcode_full = '')
      AND address IS NOT NULL AND address != ''
      AND (address || ', Southampton, UK')
          NOT IN (SELECT query FROM geocode)
  `).all() as Array<{ q: string }>;
  if (candidates.length === 0) return;

  const upsert = upsertStmt(db);
  const photonAlive = await probePhoton();

  if (photonAlive) {
    console.log(`geocode: ${candidates.length} addresses via Photon (Nominatim fallback)`);
    let ok = 0, miss = 0;
    for (const { q } of candidates) {
      const r = await photonLookup(q);
      if (r === "network_error") {
        // Photon flipped offline mid-pass — bail out and let Nominatim retry.
        console.warn("geocode: Photon went unreachable mid-pass — switching to Nominatim");
        break;
      }
      if (r) {
        upsert.run({
          $query: q, $lat: r.lat, $lon: r.lon,
          $status: "ok", $source: "photon", $fetched_at: nowIso(),
        });
        ok++;
      } else {
        upsert.run({
          $query: q, $lat: null, $lon: null,
          $status: "not_found", $source: "photon", $fetched_at: nowIso(),
        });
        miss++;
      }
      await sleep(PHOTON_DELAY_MS);
    }
    console.log(`geocode: Photon pass — ${ok} hits, ${miss} not_found`);

    // Pass 2: retry Photon's not_founds with Nominatim. UPDATE replaces.
    const retries = db.query(
      "SELECT query FROM geocode WHERE status = 'not_found' AND source = 'photon'"
    ).all() as Array<{ query: string }>;
    if (retries.length > 0) {
      console.log(`geocode: ${retries.length} Photon misses → retry via Nominatim`);
      const nomHits = await nominatimPass(retries.map(r => r.query), upsert);
      console.log(`geocode: Nominatim recovered ${nomHits}/${retries.length}`);
    }
  } else {
    // Photon down — Nominatim is the only path. Same cache, just slower.
    console.log(`geocode: Photon unreachable — ${candidates.length} addresses via Nominatim only`);
    const hits = await nominatimPass(candidates.map(c => c.q), upsert);
    console.log(`geocode: Nominatim pass — ${hits}/${candidates.length} resolved`);
  }
}

/** Single Photon health probe with a tight timeout. */
async function probePhoton(): Promise<boolean> {
  try {
    const ctl = AbortSignal.timeout(PHOTON_PROBE_MS);
    const res = await fetch("https://photon.komoot.io/api/?q=Southampton&limit=1", {
      signal: ctl,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Photon lookup. Returns a hit, `null` for a clean not_found,
 * or the sentinel `"network_error"` for transient connection failures
 * (which must NOT be cached as not_found).
 */
async function photonLookup(q: string): Promise<LatLon | null | "network_error"> {
  try {
    const url = "https://photon.komoot.io/api/"
      + `?q=${encodeURIComponent(q)}&limit=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return "network_error";
    const body = await res.json() as {
      features: Array<{ geometry: { coordinates: [number, number] } }>;
    };
    const hit = body.features?.[0];
    if (!hit) return null;
    const [lon, lat] = hit.geometry.coordinates;
    return { lat, lon };
  } catch {
    return "network_error";
  }
}

/** Returns count of resolved hits. Caches not_founds; skips on transient failures. */
async function nominatimPass(
  queries: string[],
  upsert: ReturnType<typeof upsertStmt>,
): Promise<number> {
  let hits = 0;
  for (const q of queries) {
    try {
      const url = "https://nominatim.openstreetmap.org/search"
        + `?q=${encodeURIComponent(q)}`
        + "&format=json&limit=1&countrycodes=gb";
      const res = await fetch(url, {
        headers: { "User-Agent": NOMINATIM_UA },
        signal:  AbortSignal.timeout(8000),
      });
      if (res.status === 429) {
        console.warn("geocode: Nominatim 429 — stopping pass");
        break;
      }
      if (res.ok) {
        const arr = await res.json() as Array<{ lat: string; lon: string }>;
        const hit = arr[0];
        if (hit) {
          upsert.run({
            $query: q, $lat: Number(hit.lat), $lon: Number(hit.lon),
            $status: "ok", $source: "nominatim", $fetched_at: nowIso(),
          });
          hits++;
        } else {
          upsert.run({
            $query: q, $lat: null, $lon: null,
            $status: "not_found", $source: "nominatim", $fetched_at: nowIso(),
          });
        }
      }
      // Non-2xx (not 429): treat as transient, don't cache
    } catch (err) {
      console.warn(`geocode: Nominatim error for "${q}":`, err);
    }
    await sleep(NOMINATIM_DELAY_MS);
  }
  return hits;
}

/**
 * Fire-and-forget wrapper around `runAddressGeocoding` for the dev server.
 * Latched via `_bgRunning` so re-calling while a pass is in flight is a
 * no-op — callers can safely invoke this from every request handler to
 * pick up newly-ingested listings without thrashing the geocoders.
 *
 * Accepts either an existing Database (re-used; not closed) or a connect
 * factory (a fresh handle is opened and closed). The server passes the
 * long-lived handle; CLI callers pass `connect`.
 */
export function kickoffAddressGeocodingBackground(
  source: Database | (() => Database),
): void {
  if (_bgRunning) return;
  _bgRunning = true;
  (async () => {
    const isFactory = typeof source === "function";
    const db = isFactory ? source() : source;
    try {
      await runAddressGeocoding(db);
    } catch (err) {
      console.warn("geocode: background pass errored:", err);
    } finally {
      if (isFactory) db.close();
      _bgRunning = false;
    }
  })();
}

/** Lat/lon by lookup key (postcode or full address-query). */
export function loadGeocodes(db: Database): Map<string, { lat: number; lon: number }> {
  const rows = db.query(
    "SELECT query, lat, lon FROM geocode WHERE status = 'ok' AND lat IS NOT NULL AND lon IS NOT NULL"
  ).all() as Array<{ query: string; lat: number; lon: number }>;
  return new Map(rows.map(r => [r.query, { lat: r.lat, lon: r.lon }]));
}

/** Build the same query string the background job uses, for cache lookup. */
export function addressQuery(address: string, _pcArea: string | null): string {
  return `${address}, Southampton, UK`;
}

function upsertStmt(db: Database) {
  return db.prepare(`
    INSERT INTO geocode (query, lat, lon, status, source, fetched_at)
    VALUES ($query, $lat, $lon, $status, $source, $fetched_at)
    ON CONFLICT(query) DO UPDATE SET
      lat        = excluded.lat,
      lon        = excluded.lon,
      status     = excluded.status,
      source     = excluded.source,
      fetched_at = excluded.fetched_at
  `);
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
