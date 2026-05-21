/**
 * Write `results_<portal>.md` files that the existing markdown parser
 * eats. Schema mirrors `.claude/commands/scrape.md`.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, SOURCE_LABELS } from "../config.ts";

export type ScrapedListing = {
  address:        string;
  price_pcm:      number;
  source_url:     string;
  listing_type?:  string | null;
  beds?:          number | null;
  baths?:         number | null;
  furnished?:     string | null;
  parking?:       string | null;
  epc?:           string | null;
  deposit?:       number | null;
  available?:     string | null;
  postcode_area?: string | null;
  postcode_full?: string | null;
  agent_name?:    string | null;
  description?:   string | null;
  key_features?:  string[];
  images?:        string[];
};

function bullet(name: string, value: string | number | null | undefined): string {
  if (value == null || value === "") return "";
  return `- **${name}:** ${value}\n`;
}

function formatPrice(p: number): string {
  return p.toLocaleString("en-GB");
}

function escBlock(s: string): string {
  // Strip lines that could break our parser's section detection.
  return s
    .replace(/\r\n/g, "\n")
    .replace(/^---\s*$/gm, "—")
    .trim();
}

export function renderListing(l: ScrapedListing): string {
  let out = `## ${l.address} — £${formatPrice(l.price_pcm)} pcm\n`;
  out += bullet("Link", l.source_url);
  out += bullet("Type", l.listing_type);
  if (l.beds != null || l.baths != null) {
    const beds  = l.beds  != null ? `${l.beds} bed`   : "";
    const baths = l.baths != null ? `${l.baths} bath` : "";
    out += bullet("Beds/Baths", [beds, baths].filter(Boolean).join(", "));
  }
  out += bullet("Furnished",     l.furnished);
  out += bullet("Parking",       l.parking);
  out += bullet("EPC",           l.epc);
  out += bullet("Deposit",       l.deposit != null ? `£${l.deposit}` : null);
  out += bullet("Available",     l.available);
  out += bullet("Postcode area", l.postcode_area);
  out += bullet("Postcode",      l.postcode_full);
  out += bullet("Agent",         l.agent_name);
  for (const url of l.images ?? []) {
    out += bullet("Image", url);
  }
  if (l.description) {
    out += `\n**Description:**\n${escBlock(l.description)}\n`;
  }
  if (l.key_features && l.key_features.length > 0) {
    out += `\n**Key features:**\n`;
    for (const f of l.key_features) out += `- ${f.trim()}\n`;
  }
  out += `\n---\n\n`;
  return out;
}

export function writeResults(portal: string, listings: ScrapedListing[]): string {
  const label = SOURCE_LABELS[portal] ?? portal;
  const today = new Date().toISOString().slice(0, 10);
  let body = `# ${label} — Southampton Rentals\n_Scraped ${today}_\n\n`;
  for (const l of listings) body += renderListing(l);
  const path = join(ROOT, `results_${portal}.md`);
  writeFileSync(path, body, "utf-8");
  return path;
}
