/**
 * Structured scrape logging.
 *
 * Writes a flat text log to `data/scrape.log` (append) for every
 * scrape run so failures stay diagnosable after the process exits:
 *   - one FETCH line per HTTP request (URL, status, ms, bytes, attempt)
 *   - one SKIP line per pre-filter / detail-parse rejection
 *   - one ERROR line per scraper crash or fetch failure after retries
 *   - INFO header/footer per portal with totals + skip-reason buckets
 *
 * Portal context is tracked via AsyncLocalStorage so `fetchText` doesn't
 * need to know which scraper called it — the auto-scrape orchestrator
 * wraps each scrape() promise in `inPortal(portalId, ...)`.
 */
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Avoid importing ROOT from "../config.ts" — it re-exports from
// scrapers/registry.ts which transitively imports this module, so the
// circular load leaves ROOT temporally-dead when log.ts is evaluated.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));

export const LOG_DIR  = join(ROOT, "data");
export const LOG_PATH = join(LOG_DIR, "scrape.log");

type Ctx = { portal: string; runId: string };
const als = new AsyncLocalStorage<Ctx>();

let activeRun: string | null = null;

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

function fmtKv(extra?: Record<string, unknown>): string {
  if (!extra) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${s}`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

function write(level: string, msg: string, extra?: Record<string, unknown>): void {
  ensureLogDir();
  const t = new Date().toISOString();
  const ctx = als.getStore();
  const portal = (ctx?.portal ?? "-").padEnd(11);
  const run = ctx?.runId ?? activeRun ?? "-";
  appendFileSync(LOG_PATH, `${t} [${run}] ${portal} ${level.padEnd(5)} ${msg}${fmtKv(extra)}\n`);
}

export function startScrapeRun(): string {
  const run = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  activeRun = run;
  write("INFO", "==== scrape run start ====");
  return run;
}

export function endScrapeRun(summary?: Record<string, unknown>): void {
  write("INFO", "==== scrape run end ====", summary);
  activeRun = null;
}

export function inPortal<T>(portal: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ portal, runId: activeRun ?? "-" }, fn);
}

export function withPortalSync<T>(portal: string, fn: () => T): T {
  return als.run({ portal, runId: activeRun ?? "-" }, fn);
}

export function logFetch(o: {
  url: string; status: number; ms: number; bytes: number; attempt: number;
}): void {
  const sizeKb = (o.bytes / 1024).toFixed(1);
  write("FETCH", `HTTP ${o.status} ${o.ms}ms ${sizeKb}KB`, {
    attempt: o.attempt, url: o.url,
  });
}

export function logFetchError(o: { url: string; attempt: number; err: string }): void {
  write("ERROR", "fetch failed", { attempt: o.attempt, err: o.err, url: o.url });
}

export function logSkip(id: string | number, reason: string): void {
  write("SKIP", reason, { id });
}

export function logScraperError(msg: string): void {
  write("ERROR", msg);
}

export function logPortalStart(): void {
  write("INFO", "portal start");
}

export function logPortalEnd(stats: {
  written: number; skipped: number; errors: number; durationMs: number;
  skipBuckets?: Record<string, number>;
}): void {
  write("INFO", "portal end", {
    written: stats.written, skipped: stats.skipped, errors: stats.errors,
    ms: stats.durationMs, buckets: stats.skipBuckets,
  });
}

/**
 * Group a free-text skip reason into a coarse bucket so we can show
 * "price>max: 22, beds-out-of-range: 18, students: 10" at the end of a
 * run. Patterns mirror the reasons emitted by `filters.ts` and the
 * per-portal pre-filters.
 */
export function categoriseSkip(reason: string): string {
  const r = reason.toLowerCase();
  if (/price\s*£?\d/.test(r) && /(>|outside)/.test(r))   return "price>max";
  if (/^no price\b/.test(r))                              return "no-price";
  if (/beds?\b.*outside/.test(r) || /beds?\s*\d+\s*>/.test(r) || /^no bed/.test(r)) return "beds-out-of-range";
  if (/(outcode|postcode)\b.*(not allowed|not in allow)/.test(r)) return "postcode-not-allowed";
  if (/^no postcode/.test(r))                             return "no-postcode";
  if (/student/.test(r))                                  return "students-only";
  if (/let agreed|under offer|no longer/.test(r))         return "status-dead";
  if (/^available .* > deadline/.test(r))                 return "available-past-deadline";
  if (/^http\s+\d/.test(r))                               return "http-error";
  if (/unparseable|parse failed|no .*payload|no .*propertyids|no .*real ?estate/.test(r)) return "parse-failed";
  return "other";
}
