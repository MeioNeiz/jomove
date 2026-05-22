import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { reconcileDedupeKeys } from "./reconcile.ts";
import { dedupeKey } from "./dedupe.ts";

function seed(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT, source_url TEXT UNIQUE,
      address TEXT, price_pcm INTEGER,
      postcode_area TEXT, dedupe_key TEXT,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE user_notes (
      dedupe_key TEXT PRIMARY KEY,
      viewed INTEGER NOT NULL DEFAULT 0,
      favourite INTEGER NOT NULL DEFAULT 0,
      rating INTEGER, comment TEXT,
      media_index INTEGER NOT NULL DEFAULT 0,
      cost_overrides TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE user_images (
      dedupe_key TEXT PRIMARY KEY, ext TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  return db;
}

describe("reconcileDedupeKeys", () => {
  test("merges notes from two stale keys into the new combined key", () => {
    const db = seed();

    // Two listings — Rightmove + OnTheMarket — same flat, different addresses.
    // Old dedupe_keys are whatever the previous algorithm would have computed;
    // hard-code stale strings to simulate pre-migration data.
    db.run(`INSERT INTO listings (source, source_url, address, price_pcm, postcode_area, dedupe_key, first_seen, last_seen)
            VALUES ('rightmove', 'https://rm/1', '|Ref: R153042|, Shirley Road, Southampton, SO15 3EY', 925, 'SO15', 'stale-rm-key', 't', 't')`);
    db.run(`INSERT INTO listings (source, source_url, address, price_pcm, postcode_area, dedupe_key, first_seen, last_seen)
            VALUES ('onthemarket', 'https://otm/1', 'Shirley Road, Southampton SO15', 925, 'SO15', 'stale-otm-key', 't', 't')`);

    // User annotated both separately.
    db.run(`INSERT INTO user_notes (dedupe_key, viewed, favourite, rating, comment, media_index, cost_overrides, updated_at)
            VALUES ('stale-rm-key', 1, 0, 6, 'Big rooms', 0, NULL, '2026-05-20T10:00:00Z')`);
    db.run(`INSERT INTO user_notes (dedupe_key, viewed, favourite, rating, comment, media_index, cost_overrides, updated_at)
            VALUES ('stale-otm-key', 0, 1, 8, 'Bathroom looks new', 2, NULL, '2026-05-21T10:00:00Z')`);

    const stats = reconcileDedupeKeys(db);
    expect(stats.rekeyed).toBe(2);
    expect(stats.mergedGroups).toBe(1);
    expect(stats.mergedRows).toBe(1);

    // Both listings now share the new key.
    const newKey = dedupeKey("|Ref: R153042|, Shirley Road, Southampton, SO15 3EY", 925, "SO15");
    const keys = (db.query("SELECT DISTINCT dedupe_key FROM listings").all() as Array<{dedupe_key: string}>).map(r => r.dedupe_key);
    expect(keys).toEqual([newKey]);

    // One merged note row.
    const notes = db.query("SELECT * FROM user_notes").all() as any[];
    expect(notes.length).toBe(1);
    expect(notes[0]!.dedupe_key).toBe(newKey);
    // Rating = average of 6 and 8 → 7.
    expect(notes[0]!.rating).toBe(7);
    // OR booleans.
    expect(notes[0]!.viewed).toBe(1);
    expect(notes[0]!.favourite).toBe(1);
    // Comments concatenated.
    expect(notes[0]!.comment).toContain("Big rooms");
    expect(notes[0]!.comment).toContain("Bathroom looks new");
    // media_index from the row that had a non-zero value.
    expect(notes[0]!.media_index).toBe(2);
  });

  test("idempotent — second call is a no-op", () => {
    const db = seed();
    db.run(`INSERT INTO listings (source, source_url, address, price_pcm, postcode_area, dedupe_key, first_seen, last_seen)
            VALUES ('rightmove', 'https://rm/2', 'Park Avenue', 900, 'SO17', 'stale', 't', 't')`);
    reconcileDedupeKeys(db);
    const stats2 = reconcileDedupeKeys(db);
    expect(stats2.rekeyed).toBe(0);
    expect(stats2.mergedGroups).toBe(0);
  });

  test("rekeys but doesn't merge when only one note exists", () => {
    const db = seed();
    db.run(`INSERT INTO listings (source, source_url, address, price_pcm, postcode_area, dedupe_key, first_seen, last_seen)
            VALUES ('rightmove', 'https://rm/3', '12 Park Avenue', 900, 'SO17', 'stale', 't', 't')`);
    db.run(`INSERT INTO user_notes (dedupe_key, viewed, favourite, rating, comment, media_index, cost_overrides, updated_at)
            VALUES ('stale', 1, 0, 7, 'OK', 0, NULL, '2026-05-21T10:00:00Z')`);

    const stats = reconcileDedupeKeys(db);
    expect(stats.rekeyed).toBe(1);
    expect(stats.mergedGroups).toBe(0);
    expect(stats.mergedRows).toBe(0);

    const note = db.query("SELECT * FROM user_notes").get() as any;
    expect(note.comment).toBe("OK");
    expect(note.rating).toBe(7);
  });
});
