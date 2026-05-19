#!/usr/bin/env bun
/**
 * One-shot migration: copies the user's annotations from
 * old_search/dashboard.md into the `user_notes` table, resolving each
 * listing's dedupe_key via its source_url. Re-running is safe — uses
 * INSERT OR REPLACE.
 *
 *   bun run scripts/seed-notes.ts
 */

import { connect } from "../src/db.ts";

type Seed = { url: string; comment: string };

const SEEDS: Seed[] = [
  {
    url: "https://www.rightmove.co.uk/properties/88501050", // Rosida Gardens / Hill Lane SO15 £950
    comment: "Furnishing pretty rough but location is alright right by the train station",
  },
  {
    url: "https://www.openrent.co.uk/property-to-rent/southampton/1-bed-flat-richmond-road-so15/2856684",
    comment: "Nicely furnished, kinda far, down by Millbrook 20 minutes from Common",
  },
  {
    url: "https://www.openrent.co.uk/property-to-rent/southampton/1-bed-flat-joseph-court-so17/2893737",
    comment: "Great location, near work, walk to Common — perfect flat with garden but price just a bit too high",
  },
  {
    url: "https://www.openrent.co.uk/property-to-rent/southampton/2-bed-flat-witts-hill-so18/2827106",
    comment: "Bad location, expensive",
  },
  {
    url: "https://www.rightmove.co.uk/properties/88540356", // Bellevue Road SO15 £1100
    comment: "Expensive again and not the nicest but it's alright",
  },
  {
    url: "https://www.onthemarket.com/details/19229849/", // Millbrook Road East (Link House) SO15 £1000
    comment: "Right by Central, pretty nice flat. Ideally want to be a bit closer to work/Common",
  },
  {
    url: "https://www.rightmove.co.uk/properties/88617705", // Carlton Road, Polygon SO15 £950
    comment: "Not bad furnishing, not too far from Common but not as nice as others",
  },
  {
    url: "https://www.openrent.co.uk/property-to-rent/southampton/1-bed-flat-captain-place-so14/2902514",
    comment: "Ocean Village way, crazy furnishing — disgusting, weird layout, no pics of kitchen",
  },
  {
    url: "https://www.rightmove.co.uk/properties/174131012", // The Old Chambers, College Place SO15 £875
    comment: "Unfurnished, central, not bad. Is a nice flat",
  },
  {
    url: "https://www.onthemarket.com/details/19141415/", // Southbrook Rise SO15 £950
    comment: "Again really central — I actually don't want to be really near work",
  },
];

const db = connect();
const lookup = db.query("SELECT dedupe_key, address FROM listings WHERE source_url = ?");
const upsert = db.query(`
  INSERT INTO user_notes (dedupe_key, comment, updated_at)
  VALUES ($dedupe_key, $comment, $updated_at)
  ON CONFLICT(dedupe_key) DO UPDATE SET
    comment    = excluded.comment,
    updated_at = excluded.updated_at
`);

const now = new Date().toISOString().slice(0, 19);
let written = 0, missing = 0;

for (const { url, comment } of SEEDS) {
  const row = lookup.get(url) as { dedupe_key: string; address: string } | null;
  if (!row) {
    console.warn(`  ! no listing matches ${url}`);
    missing++;
    continue;
  }
  upsert.run({
    $dedupe_key: row.dedupe_key,
    $comment:    comment,
    $updated_at: now,
  });
  console.log(`  ✓ ${row.address}\n      → ${comment}`);
  written++;
}

db.close();
console.log(`\nDone: ${written} note(s) written, ${missing} unmatched.`);
