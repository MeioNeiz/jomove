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

// Weights reflect search priorities: rail 30 > parking/price 20 > furnished/green 15 > EPC 10.
export const SCORE_SQL = `
(CASE WHEN on_direct_line = 1 THEN 30 ELSE 0 END) +
(CASE WHEN near_green_space IS NOT NULL
       AND near_green_space != ''
       AND LOWER(TRIM(near_green_space)) NOT IN ('no','none','n/a') THEN 15 ELSE 0 END) +
(CASE
   WHEN parking_status IN ('allocated','off-street','driveway') THEN 20
   WHEN parking_status IN ('permit','on-street')                THEN 10
   WHEN parking_status = 'unclear'                              THEN 5
   ELSE 0
 END) +
(CASE
   WHEN furnished_status = 'yes'      THEN 15
   WHEN furnished_status = 'optional' THEN 12
   WHEN furnished_status = 'part'     THEN 8
   WHEN furnished_status = 'unclear'  THEN 5
   ELSE 0
 END) +
(CASE
   WHEN price_pcm <= 900  THEN 20
   WHEN price_pcm <= 1000 THEN 15
   WHEN price_pcm <= 1100 THEN 10
   ELSE 0
 END) +
(CASE
   WHEN epc IN ('A','B') THEN 10
   WHEN epc = 'C'        THEN 5
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
