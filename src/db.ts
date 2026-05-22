import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "./config.ts";
import { GEOCODE_SCHEMA } from "./geocode.ts";
import { nowIso } from "./util/now.ts";
import { reconcileDedupeKeys } from "./reconcile.ts";

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

// Scoring rules moved to src/score.ts (pure TS, unit-testable).

// Bump this whenever a new entry is added to MIGRATIONS so future `connect()`
// calls run only the new step. The current version is read from app_state
// (key `schema_version`); if up to date, migrate() bails after one query.
export const SCHEMA_VERSION = 2;

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

type Migration = (db: Database) => void;

/**
 * One step per logical migration. Earlier steps are kept as-is so older DBs
 * still upgrade cleanly. Each runs inside a transaction so a crash mid-step
 * leaves the schema in a consistent state.
 */
const MIGRATIONS: Migration[] = [
  // 0 → 1: original column-add + rating-scale double migration. Now in one
  // gated step so we don't keep probing PRAGMA table_info on every connect.
  (db) => {
    const listingCols = colNames(db, "listings");
    if (!listingCols.has("image_url"))    db.exec("ALTER TABLE listings ADD COLUMN image_url TEXT");
    if (!listingCols.has("listing_type")) db.exec("ALTER TABLE listings ADD COLUMN listing_type TEXT");
    if (!listingCols.has("image_urls")) {
      db.exec("ALTER TABLE listings ADD COLUMN image_urls TEXT");
      db.exec("UPDATE listings SET image_urls = json_array(image_url) WHERE image_url IS NOT NULL");
    }
    if (!listingCols.has("description"))  db.exec("ALTER TABLE listings ADD COLUMN description TEXT");
    if (!listingCols.has("key_features")) db.exec("ALTER TABLE listings ADD COLUMN key_features TEXT");
    if (!listingCols.has("agent_name"))   db.exec("ALTER TABLE listings ADD COLUMN agent_name TEXT");

    const noteCols = colNames(db, "user_notes");
    if (!noteCols.has("media_index"))    db.exec("ALTER TABLE user_notes ADD COLUMN media_index INTEGER NOT NULL DEFAULT 0");
    if (!noteCols.has("cost_overrides")) db.exec("ALTER TABLE user_notes ADD COLUMN cost_overrides TEXT");

    const geoCols = colNames(db, "geocode");
    if (geoCols.has("postcode") && !geoCols.has("query")) {
      db.exec("ALTER TABLE geocode RENAME COLUMN postcode TO query");
    }
    if (geoCols.size > 0 && !geoCols.has("source")) {
      db.exec("ALTER TABLE geocode ADD COLUMN source TEXT");
    }

    // 5★ → 10★ rating scale upgrade, idempotent only because it's gated by
    // schema_version now (the old standalone sentinel is no longer required).
    const oldDone = db.query("SELECT 1 FROM app_state WHERE key = 'rating_scale_v2'").get();
    if (!oldDone) {
      db.exec("UPDATE user_notes SET rating = rating * 2 WHERE rating IS NOT NULL");
      db.run(
        "INSERT INTO app_state (key, value, updated_at) VALUES ('rating_scale_v2', '1', ?)",
        [nowIso()],
      );
    }
  },
  // 1 → 2: dedupe_key normalisation got smarter (strips agent refs, normalises
  // Road/Rd/St/Ave, drops leading house numbers). Re-key every listing and
  // merge user_notes that previously sat under stale keys.
  (db) => {
    const stats = reconcileDedupeKeys(db);
    if (stats.rekeyed > 0 || stats.mergedGroups > 0) {
      console.log(
        `migration: rekeyed ${stats.rekeyed} listing(s), ` +
        `merged ${stats.mergedRows} user_notes row(s) into ${stats.mergedGroups} group(s)`,
      );
    }
  },
];

function migrate(db: Database): void {
  const current = currentSchemaVersion(db);
  if (current >= SCHEMA_VERSION) return;
  for (let v = current; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) continue;
    db.transaction(() => {
      step(db);
      setSchemaVersion(db, v + 1);
    })();
  }
}

function currentSchemaVersion(db: Database): number {
  const row = db.query(
    "SELECT value FROM app_state WHERE key = 'schema_version'",
  ).get() as { value: string } | null;
  return row ? Number(row.value) || 0 : 0;
}

function setSchemaVersion(db: Database, v: number): void {
  db.run(
    `INSERT INTO app_state (key, value, updated_at) VALUES ('schema_version', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [String(v), nowIso()],
  );
}

function colNames(db: Database, table: string): Set<string> {
  const cols = db.query(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  return new Set(cols.map(c => c.name));
}
