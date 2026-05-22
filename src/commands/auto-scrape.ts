/**
 * `bun jomove.ts auto-scrape` — runs deterministic portal scrapers
 * server-side (no Claude). Writes results_<portal>.md for archival,
 * ingests directly from in-memory listings (no MD roundtrip), and
 * optionally fires an email digest.
 *
 * Each portal scraper is independent; if one fails the others
 * continue. The CLI prints a per-portal summary.
 */

import { PORTALS_BY_ID, PORTALS } from "../scrapers/registry.ts";
import { toListing } from "../scrapers/adapter.ts";
import { ingestListings } from "./ingest.ts";
import { cmdArchive } from "./archive.ts";
import { notifyNewListings } from "../notify.ts";
import { ensurePostcodeGeocodes, runAddressGeocoding } from "../geocode.ts";
import { connect } from "../db.ts";
import {
  startScrapeRun, endScrapeRun, inPortal, withPortalSync,
  logPortalStart, logPortalEnd, logSkip, logScraperError,
  categoriseSkip, LOG_PATH,
} from "../scrapers/log.ts";

export type AutoScrapeOpts = {
  portals?:  string[];
  ingest?:   boolean;
  archive?:  boolean;
  notify?:   boolean;
  archiveLabel?: string;
};

export type AutoScrapeResult = {
  portals:  string[];          // portals attempted
  total:    number;            // total listings written
  errors:   number;            // count of portals that errored or crashed
  perPortal: Array<{ portal: string; written: number; skipped: number; errors: number }>;
  durationMs: number;
};

export async function cmdAutoScrape(opts: AutoScrapeOpts): Promise<AutoScrapeResult> {
  const allKnown = PORTALS
    // Skip portals that have no deterministic scraper (e.g. Zoopla — AI-only).
    .filter(p => !p.httpVerify.skip)
    .map(p => p.id);

  const requested = opts.portals && opts.portals.length > 0
    ? opts.portals
    : allKnown;

  const unknown = requested.filter(p => !(p in PORTALS_BY_ID));
  if (unknown.length > 0) {
    console.warn(`Unknown portals (skipped): ${unknown.join(", ")}`);
  }
  const known = requested.filter(p => p in PORTALS_BY_ID && !PORTALS_BY_ID[p]!.httpVerify.skip);
  if (known.length === 0) {
    const msg = "No deterministic-scraper portals selected. Available: " + allKnown.join(", ");
    console.error(msg);
    throw new Error(msg);
  }

  console.log(`auto-scrape: running ${known.join(", ")}`);
  const t0 = Date.now();
  startScrapeRun();

  // Run in parallel — each scraper has its own per-host rate limiter.
  // Each scrape() runs inside its own portal context so fetchText knows
  // which portal to attribute requests to in the log.
  const portalStarts = known.map(() => Date.now());
  const results = await Promise.allSettled(
    known.map((p, i) => inPortal(p, async () => {
      portalStarts[i] = Date.now();
      logPortalStart();
      return PORTALS_BY_ID[p]!.scrape();
    })),
  );

  let total = 0;
  let errors = 0;
  const perPortal: AutoScrapeResult["perPortal"] = [];
  const allListings: { portal: string; listings: ReturnType<typeof toListing>[] }[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const portal = known[i]!;
    const portalMs = Date.now() - portalStarts[i]!;
    if (r.status === "rejected") {
      const msg = r.reason?.message ?? String(r.reason);
      console.error(`  ✗ ${portal}: scraper crashed — ${msg}`);
      withPortalSync(portal, () => logScraperError(`scraper crashed: ${msg}`));
      withPortalSync(portal, () => logPortalEnd({
        written: 0, skipped: 0, errors: 1, durationMs: portalMs,
      }));
      errors++;
      perPortal.push({ portal, written: 0, skipped: 0, errors: 1 });
      continue;
    }
    const report = r.value;
    total += report.written;
    if (report.errors.length > 0) errors++;
    perPortal.push({
      portal,
      written: report.written,
      skipped: report.skipped.length,
      errors:  report.errors.length,
    });

    // Replay skips + errors into the persistent log, then summarise by bucket.
    const buckets: Record<string, number> = {};
    withPortalSync(portal, () => {
      for (const s of report.skipped) {
        logSkip(s.id, s.reason);
        const b = categoriseSkip(s.reason);
        buckets[b] = (buckets[b] ?? 0) + 1;
      }
      for (const e of report.errors) logScraperError(e);
      logPortalEnd({
        written: report.written, skipped: report.skipped.length,
        errors: report.errors.length, durationMs: portalMs,
        skipBuckets: buckets,
      });
    });

    const bucketSummary = Object.entries(buckets)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");

    console.log(`  ${report.written > 0 ? "✓" : "·"} ${portal}: ${report.written} written, ${report.skipped.length} skipped, ${report.errors.length} errors (${(portalMs/1000).toFixed(1)}s)`);
    if (bucketSummary) console.log(`      skips: ${bucketSummary}`);
    if (report.errors.length > 0) {
      for (const e of report.errors) console.log(`      ! ${e}`);
    }
    if (report.written === 0 && report.skipped.length === 0 && report.errors.length === 0) {
      console.log(`      ! SCRAPER_BROKEN: no listings, no skips, no errors — check selectors`);
    }
    allListings.push({
      portal,
      listings: report.listings.map(s => toListing(portal, s)),
    });
  }
  endScrapeRun({ total, errors, ms: Date.now() - t0 });
  console.log(`auto-scrape: ${total} listings in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`log: ${LOG_PATH}`);

  if (opts.ingest !== false && total > 0) {
    console.log("--- ingesting ---");
    const db = connect();
    try {
      let inserted = 0, updated = 0;
      for (const { listings } of allListings) {
        const stats = ingestListings(db, listings);
        inserted += stats.inserted;
        updated  += stats.updated;
      }
      console.log(`Ingest done: ${inserted} new, ${updated} updated`);

      // Geocoding is part of "leave the DB ready-to-serve" — same as cmdIngest.
      try {
        await ensurePostcodeGeocodes(db);
        await runAddressGeocoding(db);
      } catch (err) {
        console.warn("Geocoding pass errored:", err);
      }

      if (opts.notify !== false) {
        await notifyNewListings(db);
      }
    } finally {
      db.close();
    }
  } else if (opts.notify !== false) {
    const db = connect();
    try { await notifyNewListings(db); } finally { db.close(); }
  }

  if (opts.archive !== false && total > 0) {
    console.log("--- archiving ---");
    cmdArchive({ label: opts.archiveLabel });
  }

  return {
    portals:    known,
    total,
    errors,
    perPortal,
    durationMs: Date.now() - t0,
  };
}
