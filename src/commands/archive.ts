import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { ROOT, SOURCES } from "../config.ts";

export type ArchiveArgs = { label?: string };

/**
 * Moves the current root-level results_*.md files into
 * `scrapes/<timestamp>[-label]/`. The DB is unaffected — it already
 * holds the ingested data. After archive, root is empty and ready for
 * the next scrape to write fresh files.
 *
 * Run this BEFORE the next scrape to preserve the previous one,
 * or AFTER the latest scrape if you'd rather snapshot now.
 */
export function cmdArchive(args: ArchiveArgs = {}): void {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const dirName = args.label ? `${stamp}-${args.label}` : stamp;
  const dir = join(ROOT, "scrapes", dirName);

  const present = Object.keys(SOURCES).filter(f => existsSync(join(ROOT, f)));
  if (present.length === 0) {
    console.log("No results_*.md files in root to archive.");
    return;
  }

  mkdirSync(dir, { recursive: true });
  for (const fname of present) {
    renameSync(join(ROOT, fname), join(dir, fname));
  }
  console.log(`Archived ${present.length} file(s) to scrapes/${dirName}/`);
  console.log(`Root is now empty — next scrape can write fresh files there.`);
}
