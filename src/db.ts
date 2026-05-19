import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "./config.ts";

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
  first_seen          TEXT NOT NULL,
  last_seen           TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_dedupe   ON listings(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_postcode ON listings(postcode_area);
CREATE INDEX IF NOT EXISTS idx_price    ON listings(price_pcm);
`;

// Simplified scoring — postcode sector is the main location signal,
// furnishing/parking are binary, direct rail is a nudge not a vote-decider.
// Max ~103.
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
(CASE WHEN on_direct_line = 1 THEN 10 ELSE 0 END) +
(CASE
   -- Sweet spot: Portswood / Highfield / Bevois Valley north
   WHEN postcode_full LIKE 'SO17 1%' OR
        postcode_full LIKE 'SO17 2%' OR
        postcode_full LIKE 'SO17 3%' OR
        (postcode_full IS NULL AND postcode_area = 'SO17') THEN 20
   -- Central but acceptable: Polygon / Bedford / Banister / St Mary's / Newtown
   WHEN postcode_full LIKE 'SO15 1%' OR
        postcode_full LIKE 'SO15 2%' OR
        postcode_full LIKE 'SO14 0%' OR
        postcode_full LIKE 'SO14 6%' OR
        postcode_full LIKE 'SO14 7%' THEN 10
   -- Penalised: Shirley/Millbrook (too far west) / Ocean Village / SO18 (too remote)
   WHEN postcode_full LIKE 'SO15 3%' OR
        postcode_full LIKE 'SO15 5%' OR
        postcode_full LIKE 'SO15 7%' OR
        postcode_full LIKE 'SO15 8%' OR
        postcode_full LIKE 'SO14 1%' OR
        postcode_full LIKE 'SO14 2%' OR
        postcode_full LIKE 'SO14 3%' OR
        postcode_full LIKE 'SO14 5%' OR
        postcode_full LIKE 'SO18%'   OR
        (postcode_full IS NULL AND postcode_area IN ('SO18')) THEN 0
   -- Fallback for area-only matches without a full sector
   WHEN postcode_full IS NULL AND postcode_area IN ('SO15','SO14') THEN 5
   ELSE 0
 END) +
(CASE
   WHEN near_green_space IS NOT NULL
        AND LOWER(near_green_space) LIKE '%common%' THEN 10
   ELSE 0
 END) +
(CASE
   WHEN epc IN ('A','B') THEN 8
   WHEN epc = 'C'        THEN 4
   ELSE 0
 END)
`;

export function connect(): Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(SCHEMA);
  return db;
}
