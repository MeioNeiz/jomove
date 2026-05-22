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
import { loadGeocodes, addressQuery } from "./geocode.ts";
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

type GeoMap = Map<string, { lat: number; lon: number }>;

/** Pick the same lat/lon the dashboard would: full postcode first, then geocoded address. */
function coordFor(r: ListingRow, geo: GeoMap): { lat: number; lon: number } | null {
  if (r.postcode_full) {
    const c = geo.get(r.postcode_full);
    if (c) return c;
  }
  return geo.get(addressQuery(r.address, r.postcode_area)) ?? null;
}

/**
 * 2×2 OSM tile grid centred on (lat, lon) at the same zoom as the
 * dashboard map (13). Rendered as a borderless email-safe HTML table —
 * Gmail / Outlook / Apple Mail all collapse the cells cleanly. The
 * listing sits roughly at the inner cross of the four tiles (good
 * enough; for pin-precise location we add a Google Maps link).
 */
function tileGridHtml(lat: number, lon: number, mapsLink: string, zoom = 13): string {
  const n = Math.pow(2, zoom);
  const xFloat = ((lon + 180) / 360) * n;
  const yFloat = ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  const xL = Math.round(xFloat) - 1, xR = Math.round(xFloat);
  const yT = Math.round(yFloat) - 1, yB = Math.round(yFloat);
  const tile = (x: number, y: number) =>
    `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
  const cell = (x: number, y: number) =>
    `<td style="padding:0;line-height:0"><img src="${tile(x, y)}" width="200" height="200" alt="" style="display:block;border:0"></td>`;
  return `
<a href="${esc(mapsLink)}" style="text-decoration:none">
  <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;border-radius:6px;overflow:hidden;margin:0 0 10px 0;display:block">
    <tr>${cell(xL, yT)}${cell(xR, yT)}</tr>
    <tr>${cell(xL, yB)}${cell(xR, yB)}</tr>
  </table>
</a>`;
}

function metaLine(r: ListingRow): string {
  const portal = SOURCE_LABELS[r.source] ?? r.source;
  const beds = r.beds != null ? `${r.beds} bed` : "?";
  const baths = r.baths != null ? `, ${r.baths} bath` : "";
  const pc = r.postcode_full ?? r.postcode_area ?? "";
  const parts = [
    esc(portal),
    esc(beds + baths),
    pc ? esc(pc) : null,
    r.listing_type ? esc(r.listing_type) : null,
    r.furnished_status && r.furnished_status !== "unclear" ? esc(`furnished: ${r.furnished_status}`) : null,
    r.epc ? esc(`EPC ${r.epc}`) : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function renderListingCard(r: ListingRow, geo: GeoMap): string {
  const coord = coordFor(r, geo);
  const mapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    r.address ? `${r.address}, Southampton, UK` : (r.postcode_full || r.postcode_area || "Southampton")
  )}`;
  const photo = r.image_url
    ? `<img src="${esc(r.image_url)}" alt="" width="400" style="display:block;border-radius:6px;margin:0 0 10px 0;max-width:100%;height:auto">`
    : "";
  const map = coord ? tileGridHtml(coord.lat, coord.lon, mapsLink) : "";
  const why = r.why_worth_a_look
    ? `<div style="font-size:13px;color:#444;margin-top:6px">${esc(r.why_worth_a_look)}</div>`
    : "";
  const caveats = r.caveats
    ? `<div style="font-size:12px;color:#a04040;margin-top:4px">⚠ ${esc(r.caveats)}</div>`
    : "";
  const agent = r.agent_name
    ? `<div style="font-size:12px;color:#888;margin-top:4px">${esc(r.agent_name)}</div>`
    : "";

  return `
<div style="border:1px solid #ddd;border-radius:10px;padding:14px 16px;margin:0 0 16px 0;background:#fff;font-family:-apple-system,Segoe UI,sans-serif">
  ${photo}
  ${map}
  <div style="font-size:17px;font-weight:600;line-height:1.3">
    <a href="${esc(r.source_url)}" style="color:#1a73e8;text-decoration:none">£${r.price_pcm} pcm — ${esc(r.address)}</a>
  </div>
  <div style="font-size:13px;color:#666;margin-top:4px">${metaLine(r)}</div>
  ${agent}
  ${why}
  ${caveats}
</div>`;
}

export function renderDigest(rows: ListingRow[], geo: GeoMap): { subject: string; html: string; text: string } {
  const n = rows.length;
  const subject = n === 1
    ? `Jomove: 1 new flat — ${rows[0]!.address}`
    : `Jomove: ${n} new flats`;
  const html = `
<!doctype html><html><body style="background:#f5f5f7;margin:0;padding:20px;font-family:-apple-system,Segoe UI,sans-serif">
<div style="max-width:480px;margin:0 auto">
  <h2 style="margin:0 0 16px 0;font-size:20px">${esc(subject)}</h2>
  ${rows.map(r => renderListingCard(r, geo)).join("\n")}
  <div style="font-size:11px;color:#999;text-align:center;margin-top:8px">
    auto-scrape · ${new Date().toISOString().slice(0, 16).replace("T", " ")} ·
    <a href="https://jomove.jomify.lol/" style="color:#999">open dashboard</a>
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

  const geo = loadGeocodes(db);
  const { subject, html, text } = renderDigest(rows, geo);
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
