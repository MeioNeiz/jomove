/**
 * Email notifications for newly-seen listings.
 *
 * After `auto-scrape` ingests, we look up rows whose `first_seen` is
 * later than the timestamp we stored in `app_state` last time
 * notifications ran. The new rows get bundled into one HTML digest
 * and sent via SMTP.
 *
 * Configured by env vars (read from .env via Bun's loader):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, NOTIFY_FROM, NOTIFY_TO
 *
 * If any required var is missing we no-op with a warning — keeps the
 * scraper usable for people who haven't set SMTP up yet.
 *
 * Bootstrap rule: if `last_notified_at` doesn't exist (very first
 * run), we set it to "now" and notify ZERO listings. Without this,
 * the first run would mail 300+ "new" listings at once.
 */

import nodemailer from "nodemailer";
import type { Database } from "bun:sqlite";
import type { ListingRow } from "./types.ts";
import { SOURCE_LABELS } from "./config.ts";
import { nowIso } from "./util/now.ts";
import { esc } from "./util/html.ts";

export type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  to:   string;
};

function envOrNull(k: string): string | null {
  const v = process.env[k];
  return v && v.length > 0 ? v : null;
}

export function readSmtpConfig(): SmtpConfig | null {
  const host = envOrNull("SMTP_HOST");
  const portStr = envOrNull("SMTP_PORT");
  const user = envOrNull("SMTP_USER");
  const pass = envOrNull("SMTP_PASS");
  const from = envOrNull("NOTIFY_FROM") ?? user;
  const to   = envOrNull("NOTIFY_TO");
  if (!host || !portStr || !user || !pass || !from || !to) return null;
  const port = parseInt(portStr, 10);
  if (!port) return null;
  return { host, port, user, pass, from, to };
}

const LAST_NOTIFIED_KEY = "last_notified_at";

function getLastNotified(db: Database): string | null {
  const row = db.query("SELECT value FROM app_state WHERE key = ?")
    .get(LAST_NOTIFIED_KEY) as { value: string } | null;
  return row?.value ?? null;
}

function setLastNotified(db: Database, iso: string): void {
  db.run(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [LAST_NOTIFIED_KEY, iso, iso],
  );
}

function fetchNewSince(db: Database, sinceIso: string): ListingRow[] {
  return db.query(`SELECT * FROM listings
     WHERE status = 'active' AND first_seen > ?
     ORDER BY first_seen DESC, price_pcm ASC`)
    .all(sinceIso) as ListingRow[];
}

function renderListingCard(r: ListingRow): string {
  const portal = SOURCE_LABELS[r.source] ?? r.source;
  const beds = r.beds != null ? `${r.beds} bed` : "?";
  const baths = r.baths != null ? `, ${r.baths} bath` : "";
  const pc = r.postcode_full ?? r.postcode_area ?? "";
  const img = r.image_url
    ? `<img src="${esc(r.image_url)}" alt="" width="200" style="display:block;border-radius:4px;margin:0 0 8px 0">`
    : "";
  return `
<div style="border:1px solid #ddd;border-radius:8px;padding:12px 14px;margin:0 0 14px 0;font-family:-apple-system,Segoe UI,sans-serif">
  ${img}
  <div style="font-size:16px;font-weight:600">
    <a href="${esc(r.source_url)}" style="color:#1a73e8;text-decoration:none">£${r.price_pcm} pcm — ${esc(r.address)}</a>
  </div>
  <div style="font-size:13px;color:#666;margin-top:4px">
    ${esc(portal)} · ${esc(beds + baths)} · ${esc(pc)}${r.listing_type ? ` · ${esc(r.listing_type)}` : ""}
  </div>
</div>`;
}

function renderDigest(rows: ListingRow[]): { subject: string; html: string; text: string } {
  const n = rows.length;
  const subject = n === 1
    ? `Jomove: 1 new flat — ${rows[0]!.address}`
    : `Jomove: ${n} new flats`;
  const html = `
<!doctype html><html><body style="background:#f5f5f7;margin:0;padding:20px;font-family:-apple-system,Segoe UI,sans-serif">
<div style="max-width:520px;margin:0 auto">
  <h2 style="margin:0 0 16px 0">${esc(subject)}</h2>
  ${rows.map(renderListingCard).join("\n")}
  <div style="font-size:11px;color:#999;text-align:center;margin-top:8px">
    auto-scrape · ${new Date().toISOString().slice(0, 16).replace("T", " ")}
  </div>
</div></body></html>`;
  const text = rows.map(r => {
    const pc = r.postcode_full ?? r.postcode_area ?? "";
    return `£${r.price_pcm} pcm — ${r.address}\n  ${SOURCE_LABELS[r.source] ?? r.source} · ${r.beds ?? "?"} bed${r.listing_type ? ` ${r.listing_type}` : ""} · ${pc}\n  ${r.source_url}`;
  }).join("\n\n");
  return { subject, html, text };
}

/**
 * Send the digest. Returns the number of new listings notified.
 * No-op (returns 0) when SMTP isn't configured.
 */
export async function notifyNewListings(db: Database): Promise<number> {
  const cfg = readSmtpConfig();
  if (!cfg) {
    console.warn("notify: SMTP not configured (set SMTP_HOST/PORT/USER/PASS/NOTIFY_TO in .env) — skipping");
    return 0;
  }

  const now = nowIso();
  const since = getLastNotified(db);
  if (!since) {
    setLastNotified(db, now);
    console.log("notify: bootstrapping last_notified_at — no email this run");
    return 0;
  }

  const rows = fetchNewSince(db, since);
  if (rows.length === 0) {
    setLastNotified(db, now);
    console.log("notify: no new listings since " + since);
    return 0;
  }

  const { subject, html, text } = renderDigest(rows);
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  try {
    await transport.sendMail({
      from: cfg.from,
      to:   cfg.to,
      subject,
      html,
      text,
    });
    setLastNotified(db, now);
    console.log(`notify: emailed ${rows.length} new listing(s) to ${cfg.to}`);
    return rows.length;
  } catch (err) {
    console.error(`notify: send failed — ${(err as Error).message}`);
    return 0;
  }
}
