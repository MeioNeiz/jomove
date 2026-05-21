import { connect } from "../db.ts";

export type PruneArgs = { days: number; dryRun: boolean };

/**
 * Marks any listing whose `last_seen` is older than `args.days` days as
 * `status = 'let_agreed'`. Run after a fresh scrape to flag listings that
 * disappeared from the portals.
 *
 * Use `--dry-run` to preview without writing.
 */
export function cmdPrune(args: PruneArgs): void {
  const db = connect();
  const cutoffMs = Date.now() - args.days * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString().slice(0, 19);

  const stale = db.query(
    `SELECT id, source, address, price_pcm, last_seen
     FROM listings
     WHERE status = 'active' AND last_seen < ?
     ORDER BY last_seen ASC`
  ).all(cutoffIso) as Array<{
    id: number; source: string; address: string;
    price_pcm: number; last_seen: string;
  }>;

  if (stale.length === 0) {
    console.log(`No active listings older than ${args.days} day(s) (cutoff ${cutoffIso}).`);
    db.close();
    return;
  }

  console.log(
    `${args.dryRun ? "Would mark" : "Marking"} ${stale.length} listing(s) ` +
    `as let_agreed (last_seen < ${cutoffIso}):`
  );
  for (const r of stale) {
    console.log(`  [${r.source}] £${r.price_pcm}  ${r.address}  (last_seen ${r.last_seen})`);
  }

  if (!args.dryRun) {
    db.query(
      `UPDATE listings SET status = 'let_agreed' WHERE status = 'active' AND last_seen < ?`
    ).run(cutoffIso);
    console.log(`Done. The dev server picks this up on the next poll.`);
  } else {
    console.log(`Dry run — no changes written.`);
  }

  db.close();
}
