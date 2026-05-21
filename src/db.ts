import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "./config.ts";
import { GEOCODE_SCHEMA } from "./geocode.ts";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  source              TEXT    NOT NULL,
  source_url          TEXT    NOT NULL UNIQUE,
  address             TEXT    NOT NULL,
  price_pcm           INTEGER NOT NULL,
  beds                INTEGER,
  baths               INTEGER,
  furnished_raw       TEXT,
  furnished_status    TEXT,
  parking_raw         TEXT,
  parking_status      TEXT,
  epc                 TEXT,
  deposit             INTEGER,
  available_raw       TEXT,
  available_date      TEXT,
  postcode_area       TEXT,
  postcode_full       TEXT,
  neighbourhood       TEXT,
  near_green_space    TEXT,
  rail_access         TEXT,
  on_direct_line      INTEGER,
  why_worth_a_look    TEXT,
  caveats             TEXT,
  dedupe_key          TEXT,
  image_url           TEXT,
  image_urls          TEXT,
  listing_type        TEXT,
  description         TEXT,
  key_features        TEXT,
  agent_name          TEXT,
  first_seen          TEXT NOT NULL,
  last_seen           TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_dedupe   ON listings(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_postcode ON listings(postcode_area);
CREATE INDEX IF NOT EXISTS idx_price    ON listings(price_pcm);

-- Per-listing user annotations. Keyed on dedupe_key so a property's notes
-- survive being re-found across portals or in later scrapes.
CREATE TABLE IF NOT EXISTS user_notes (
  dedupe_key     TEXT PRIMARY KEY,
  viewed         INTEGER NOT NULL DEFAULT 0,
  favourite      INTEGER NOT NULL DEFAULT 0,
  rating         INTEGER,
  comment        TEXT,
  cost_overrides TEXT,
  updated_at     TEXT NOT NULL
);

-- Generic singleton-style key/value store for app-level state:
-- last_visit_at (NEW-badge cutoff), filters (last filter selections),
-- sort (last sort selection). Values are JSON strings.
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- User-pasted images saved locally. File at data/user-images/<sha1(key)>.<ext>.
CREATE TABLE IF NOT EXISTS user_images (
  dedupe_key TEXT PRIMARY KEY,
  ext        TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
` + GEOCODE_SCHEMA;

// Scoring tuned to user ratings/comments (2026-05-20):
// - Common proximity + N. Stoneham commute = SO17 1 (Highfield) is sweet spot
// - Central postcodes actively penalised (user comments: "too central")
// - Rail signal removed (no correlation with user ratings)
// - Availability past move-in deadline soft-penalised
// - Studio/no-bed slight penalty (user "no bed?" comments)
// - Bad EPC handled by cost adjustment, not score
export const MOVE_IN_DEADLINE = "2026-06-29";

export const SCORE_SQL = `
(CASE
   WHEN price_pcm <= 900  THEN 20
   WHEN price_pcm <= 1000 THEN 15
   WHEN price_pcm <= 1100 THEN 10
   ELSE 0
 END) +
(CASE
   WHEN furnished_status IN ('yes','optional','part') THEN 15
   WHEN furnished_status = 'unclear'                  THEN 7
   ELSE 0
 END) +
(CASE
   WHEN parking_status IN ('allocated','off-street','driveway','permit','on-street') THEN 10
   WHEN parking_status = 'unclear'                                                   THEN 5
   ELSE 0
 END) +
(CASE
   -- Sweet spot: Highfield — walking to Common AND short hop to N. Stoneham
   WHEN postcode_full LIKE 'SO17 1%' THEN 25
   -- Portswood / Bevois — walking to Common
   WHEN postcode_full LIKE 'SO17 2%' OR
        postcode_full LIKE 'SO17 3%' THEN 20
   WHEN postcode_full IS NULL AND postcode_area = 'SO17' THEN 18
   -- Bassett — between Common and work
   WHEN postcode_full LIKE 'SO16 5%' OR
        postcode_full LIKE 'SO16 7%' THEN 15
   -- Eastleigh — closest to N. Stoneham work
   WHEN postcode_full LIKE 'SO50%' OR
        (postcode_full IS NULL AND postcode_area = 'SO50') THEN 10
   -- Banister / west of centre — neutral acceptable
   WHEN postcode_full LIKE 'SO15 2%' THEN 5
   -- Central — penalised (user: "too central")
   WHEN postcode_full LIKE 'SO14 0%' OR
        postcode_full LIKE 'SO14 6%' OR
        postcode_full LIKE 'SO14 7%' OR
        postcode_full LIKE 'SO15 1%' THEN -5
   -- Shirley / Millbrook / Ocean Village / SO18 — too far
   WHEN postcode_full LIKE 'SO15 3%' OR
        postcode_full LIKE 'SO15 5%' OR
        postcode_full LIKE 'SO15 7%' OR
        postcode_full LIKE 'SO15 8%' OR
        postcode_full LIKE 'SO14 1%' OR
        postcode_full LIKE 'SO14 2%' OR
        postcode_full LIKE 'SO14 3%' OR
        postcode_full LIKE 'SO14 5%' OR
        postcode_full LIKE 'SO18%' THEN -5
   WHEN postcode_full IS NULL AND postcode_area = 'SO18' THEN -5
   ELSE 0
 END) +
(CASE
   WHEN near_green_space IS NOT NULL
        AND LOWER(near_green_space) LIKE '%common%' THEN 15
   ELSE 0
 END) +
(CASE
   WHEN epc IN ('A','B') THEN 8
   WHEN epc = 'C'        THEN 4
   ELSE 0
 END) +
(CASE
   WHEN available_date IS NOT NULL AND available_date > '${MOVE_IN_DEADLINE}' THEN -10
   ELSE 0
 END) +
(CASE
   WHEN beds IS NULL OR LOWER(COALESCE(listing_type,'')) = 'studio' THEN -5
   ELSE 0
 END)
`;

export function connect(): Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  // WAL + busy_timeout: lets the background geocoder write while request
  // handlers also read/write without SQLITE_BUSY thrash.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Lightweight column-add migrations for older DBs created before a field
 * existed. SQLite ALTER TABLE ADD COLUMN is forward-compatible.
 */
function migrate(db: Database): void {
  const listingCols = colNames(db, "listings");
  if (!listingCols.has("image_url")) {
    db.exec("ALTER TABLE listings ADD COLUMN image_url TEXT");
  }
  if (!listingCols.has("listing_type")) {
    db.exec("ALTER TABLE listings ADD COLUMN listing_type TEXT");
  }
  if (!listingCols.has("image_urls")) {
    db.exec("ALTER TABLE listings ADD COLUMN image_urls TEXT");
    // Backfill: existing rows with a single image_url become a 1-element JSON
    // array so the new code path doesn't lose them.
    db.exec("UPDATE listings SET image_urls = json_array(image_url) WHERE image_url IS NOT NULL");
  }
  if (!listingCols.has("description")) {
    db.exec("ALTER TABLE listings ADD COLUMN description TEXT");
  }
  if (!listingCols.has("key_features")) {
    db.exec("ALTER TABLE listings ADD COLUMN key_features TEXT");
  }
  if (!listingCols.has("agent_name")) {
    db.exec("ALTER TABLE listings ADD COLUMN agent_name TEXT");
  }
  const noteCols = colNames(db, "user_notes");
  if (!noteCols.has("media_index")) {
    db.exec("ALTER TABLE user_notes ADD COLUMN media_index INTEGER NOT NULL DEFAULT 0");
  }
  if (!noteCols.has("cost_overrides")) {
    db.exec("ALTER TABLE user_notes ADD COLUMN cost_overrides TEXT");
  }
  // geocode table: original column was `postcode`, now generic `query`.
  const geoCols = colNames(db, "geocode");
  if (geoCols.has("postcode") && !geoCols.has("query")) {
    db.exec("ALTER TABLE geocode RENAME COLUMN postcode TO query");
  }
  if (geoCols.size > 0 && !geoCols.has("source")) {
    db.exec("ALTER TABLE geocode ADD COLUMN source TEXT");
  }

  // One-shot: 5-star scale → 10-star scale. Doubles existing ratings so 4★
  // becomes 8★ etc. Guarded via app_state so it can't run twice.
  const done = db.query("SELECT 1 FROM app_state WHERE key = 'rating_scale_v2'").get();
  if (!done) {
    db.exec("UPDATE user_notes SET rating = rating * 2 WHERE rating IS NOT NULL");
    db.run(
      "INSERT INTO app_state (key, value, updated_at) VALUES ('rating_scale_v2', '1', ?)",
      [new Date().toISOString()],
    );
  }
}

function colNames(db: Database, table: string): Set<string> {
  const cols = db.query(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  return new Set(cols.map(c => c.name));
}
