/**
 * `bun jomove.ts auto-scrape` — runs deterministic portal scrapers
 * server-side (no Claude). Writes results_<portal>.md and optionally
 * chains ingest + archive.
 *
 * Each portal scraper is independent; if one fails the others
 * continue. The CLI prints a per-portal summary.
 */

import { scrapeOpenRent, type ScrapeReport } from "../scrapers/openrent.ts";
import { scrapeRightmove } from "../scrapers/rightmove.ts";
import { scrapeOnTheMarket } from "../scrapers/onthemarket.ts";
import { scrapeGumtree } from "../scrapers/gumtree.ts";
import { cmdIngest } from "./ingest.ts";
import { cmdArchive } from "./archive.ts";
import { notifyNewListings } from "../notify.ts";
import { connect } from "../db.ts";

type ScrapeFn = () => Promise<ScrapeReport>;

const REGISTRY: Record<string, ScrapeFn> = {
  openrent:    scrapeOpenRent,
  rightmove:   scrapeRightmove,
  onthemarket: scrapeOnTheMarket,
  gumtree:     scrapeGumtree,
};

export type AutoScrapeOpts = {
  portals?:  string[];
  ingest?:   boolean;
  archive?:  boolean;
  notify?:   boolean;
  archiveLabel?: string;
};

export async function cmdAutoScrape(opts: AutoScrapeOpts): Promise<void> {
  const requested = opts.portals && opts.portals.length > 0
    ? opts.portals
    : Object.keys(REGISTRY);

  const unknown = requested.filter(p => !(p in REGISTRY));
  if (unknown.length > 0) {
    console.warn(`Unknown portals (skipped): ${unknown.join(", ")}`);
  }
  const known = requested.filter(p => p in REGISTRY);
  if (known.length === 0) {
    console.error("No known portals selected. Available: " + Object.keys(REGISTRY).join(", "));
    process.exit(1);
  }

  console.log(`auto-scrape: running ${known.join(", ")}`);
  const t0 = Date.now();

  // Run in parallel — each scraper has its own per-host rate limiter.
  const results = await Promise.allSettled(
    known.map(p => REGISTRY[p]!().then(r => ({ portal: p, report: r }))),
  );

  let total = 0;
  for (const r of results) {
    if (r.status === "rejected") {
      console.error(`  ✗ scraper crashed: ${r.reason?.message ?? r.reason}`);
      continue;
    }
    const { portal, report } = r.value;
    total += report.written;
    console.log(`  ${report.written > 0 ? "✓" : "·"} ${portal}: ${report.written} written, ${report.skipped.length} skipped, ${report.errors.length} errors`);
    if (report.errors.length > 0) {
      for (const e of report.errors) console.log(`      ! ${e}`);
    }
    if (report.written === 0 && report.skipped.length === 0 && report.errors.length === 0) {
      console.log(`      ! SCRAPER_BROKEN: no listings, no skips, no errors — check selectors`);
    }
  }
  console.log(`auto-scrape: ${total} listings in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (opts.ingest !== false && total > 0) {
    console.log("--- ingesting ---");
    await cmdIngest(["."]);
  }
  if (opts.notify !== false) {
    const db = connect();
    try { await notifyNewListings(db); } finally { db.close(); }
  }
  if (opts.archive !== false && total > 0) {
    console.log("--- archiving ---");
    cmdArchive({ label: opts.archiveLabel });
  }
}
