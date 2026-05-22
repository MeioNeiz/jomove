/**
 * Cross-portal duplicate reconciliation.
 *
 * `dedupeKey()` decides when two listings are the same flat. When it
 * gets smarter (e.g. learns to ignore an agent ref code), historical
 * rows in `listings` carry stale keys and the user may have annotated
 * two-now-merged listings independently. `reconcileDedupeKeys` walks
 * every listing, recomputes its key, and merges `user_notes` rows that
 * collide on the new key per the rules the user specified:
 *
 *   - comments:   concatenated with a portal separator
 *   - rating:     mean of non-null ratings, rounded to nearest int
 *   - viewed:     OR across rows
 *   - favourite:  OR across rows
 *   - media_index:   first non-zero (no good merge rule; one wins)
 *   - cost_overrides: first non-null
 *
 * Idempotent. Safe to call from a migration step or after a schema
 * change. Returns counts so the caller can log "rekeyed X, merged Y".
 */
import type { Database } from "bun:sqlite";
import { dedupeKey } from "./dedupe.ts";
import { nowIso } from "./util/now.ts";

export type ReconcileStats = {
  rekeyed: number;       // listings whose dedupe_key changed
  mergedGroups: number;  // user_notes groups (≥2 rows) collapsed into 1
  mergedRows: number;    // total user_notes rows removed by merging
};

type NoteRow = {
  dedupe_key:     string;
  viewed:         number;
  favourite:      number;
  rating:         number | null;
  comment:        string | null;
  media_index:    number | null;
  cost_overrides: string | null;
  updated_at:     string;
};

function mergeNotes(rows: NoteRow[]): Omit<NoteRow, "dedupe_key"> {
  // Stable order: newest updated_at last so its media_index / cost_overrides
  // wins ties.
  const ordered = [...rows].sort((a, b) => a.updated_at.localeCompare(b.updated_at));

  const comments = ordered
    .map(r => (r.comment ?? "").trim())
    .filter(Boolean);
  // De-duplicate identical comments (user may have pasted the same note
  // onto two portals) before joining.
  const uniqueComments: string[] = [];
  for (const c of comments) if (!uniqueComments.includes(c)) uniqueComments.push(c);
  const comment = uniqueComments.join("\n\n— merged from another portal —\n\n");

  const ratings = ordered.map(r => r.rating).filter((r): r is number => r != null);
  const rating = ratings.length > 0
    ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length)
    : null;

  const viewed     = ordered.some(r => Boolean(r.viewed))    ? 1 : 0;
  const favourite  = ordered.some(r => Boolean(r.favourite)) ? 1 : 0;
  const media_index = ordered.find(r => (r.media_index ?? 0) > 0)?.media_index ?? 0;
  const cost_overrides = ordered.reverse().find(r => r.cost_overrides)?.cost_overrides ?? null;
  const updated_at = ordered.length > 0 ? ordered[ordered.length - 1]!.updated_at : nowIso();

  return { viewed, favourite, rating, comment, media_index, cost_overrides, updated_at };
}

/**
 * Recompute dedupe_key for every listing using the current logic, then
 * merge user_notes rows that collide on the new key.
 */
export function reconcileDedupeKeys(db: Database): ReconcileStats {
  const stats: ReconcileStats = { rekeyed: 0, mergedGroups: 0, mergedRows: 0 };

  const tx = db.transaction(() => {
    // 1. Walk every listing, compute the new key, update if changed.
    //    Also build a map of old→new for the notes-merge step.
    const listings = db.query(
      "SELECT id, address, price_pcm, postcode_area, dedupe_key FROM listings"
    ).all() as Array<{
      id: number; address: string; price_pcm: number;
      postcode_area: string | null; dedupe_key: string | null;
    }>;

    const update = db.query("UPDATE listings SET dedupe_key = ? WHERE id = ?");
    const oldToNew = new Map<string, string>();
    for (const r of listings) {
      const newKey = dedupeKey(r.address, r.price_pcm, r.postcode_area);
      if (newKey !== r.dedupe_key) {
        update.run(newKey, r.id);
        stats.rekeyed++;
      }
      if (r.dedupe_key && r.dedupe_key !== newKey) {
        oldToNew.set(r.dedupe_key, newKey);
      }
    }

    // 2. Find any user_notes whose key is now stale, AND group everything
    //    that collides on the new key. We collect *all* notes rows whose
    //    key appears in oldToNew or shares a target with one.
    if (oldToNew.size === 0) return;

    const oldKeys = [...oldToNew.keys()];
    const newTargets = new Set(oldToNew.values());

    // All notes that need to be remapped or that already live at one of
    // the new target keys (so they merge cleanly).
    const placeholders = oldKeys.map(() => "?").join(",");
    const affectedRows = db.query(
      `SELECT dedupe_key, viewed, favourite, rating, comment, media_index, cost_overrides, updated_at
         FROM user_notes
        WHERE dedupe_key IN (${placeholders})
           OR dedupe_key IN (SELECT value FROM json_each(?))`
    ).all(...oldKeys, JSON.stringify([...newTargets])) as NoteRow[];

    if (affectedRows.length === 0) return;

    // Bucket each note by its FINAL key (post-rekey).
    const byNewKey = new Map<string, NoteRow[]>();
    for (const row of affectedRows) {
      const final = oldToNew.get(row.dedupe_key) ?? row.dedupe_key;
      const arr = byNewKey.get(final);
      if (arr) arr.push(row); else byNewKey.set(final, [row]);
    }

    const upsert = db.query(`
      INSERT INTO user_notes (dedupe_key, viewed, favourite, rating, comment, media_index, cost_overrides, updated_at)
      VALUES ($k, $v, $f, $r, $c, $m, $o, $u)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        viewed = excluded.viewed, favourite = excluded.favourite,
        rating = excluded.rating, comment = excluded.comment,
        media_index = excluded.media_index, cost_overrides = excluded.cost_overrides,
        updated_at = excluded.updated_at
    `);
    const del = db.query("DELETE FROM user_notes WHERE dedupe_key = ?");

    for (const [newKey, rows] of byNewKey) {
      const merged = mergeNotes(rows);
      // Delete every old key, then write the merged row at newKey.
      for (const r of rows) {
        if (r.dedupe_key !== newKey) del.run(r.dedupe_key);
      }
      upsert.run({
        $k: newKey, $v: merged.viewed, $f: merged.favourite,
        $r: merged.rating, $c: merged.comment, $m: merged.media_index,
        $o: merged.cost_overrides, $u: merged.updated_at,
      });
      if (rows.length > 1) {
        stats.mergedGroups++;
        stats.mergedRows += rows.length - 1;
      }
    }

    // 3. Same for user_images — keyed by dedupe_key. Cheaper: just rename
    //    the row to the new key when a single image lives at an old key,
    //    skipping if the new key already has one (keep first; second is
    //    silently dropped, but the user_image filesystem file remains and
    //    we don't risk losing data).
    const imgRow = db.query("SELECT dedupe_key, ext, updated_at FROM user_images WHERE dedupe_key IN (" + placeholders + ")");
    const imgUpsert = db.query(`
      INSERT INTO user_images (dedupe_key, ext, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(dedupe_key) DO NOTHING
    `);
    const imgDel = db.query("DELETE FROM user_images WHERE dedupe_key = ?");
    const images = imgRow.all(...oldKeys) as Array<{ dedupe_key: string; ext: string; updated_at: string }>;
    for (const img of images) {
      const newKey = oldToNew.get(img.dedupe_key);
      if (!newKey) continue;
      imgUpsert.run(newKey, img.ext, img.updated_at);
      imgDel.run(img.dedupe_key);
    }
  });
  tx();

  return stats;
}
