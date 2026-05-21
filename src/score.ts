/**
 * Listing scoring — pure TS so it's unit-testable and tweakable in one
 * place. Replaces the old SCORE_SQL string in db.ts.
 *
 * The rules below mirror the previous SQL exactly. Each rule returns a
 * positive or negative integer; the score is their sum.
 *
 * Adding a new rule: write a function `(row) => number`, add it to RULES.
 */

import { DEADLINE } from "./config.ts";

export type ScoreInput = {
  price_pcm:        number | null;
  furnished_status: string | null;
  parking_status:   string | null;
  postcode_full:    string | null;
  postcode_area:    string | null;
  near_green_space: string | null;
  epc:              string | null;
  available_date:   string | null;
  beds:             number | null;
  listing_type:     string | null;
};

type Rule = (r: ScoreInput) => number;

const priceRule: Rule = (r) => {
  const p = r.price_pcm ?? Infinity;
  if (p <= 900)  return 20;
  if (p <= 1000) return 15;
  if (p <= 1100) return 10;
  return 0;
};

const furnishedRule: Rule = (r) => {
  const f = r.furnished_status;
  if (f === "yes" || f === "optional" || f === "part") return 15;
  if (f === "unclear") return 7;
  return 0;
};

const parkingRule: Rule = (r) => {
  const p = r.parking_status;
  if (p === "allocated" || p === "off-street" || p === "driveway" ||
      p === "permit" || p === "on-street") return 10;
  if (p === "unclear") return 5;
  return 0;
};

const postcodeRule: Rule = (r) => {
  const pc = r.postcode_full ?? "";
  const area = r.postcode_area ?? "";
  // Sweet spot: Highfield — Common + N. Stoneham
  if (pc.startsWith("SO17 1")) return 25;
  // Portswood / Bevois — walking to Common
  if (pc.startsWith("SO17 2") || pc.startsWith("SO17 3")) return 20;
  if (!pc && area === "SO17") return 18;
  // Bassett — between Common and work
  if (pc.startsWith("SO16 5") || pc.startsWith("SO16 7")) return 15;
  // Eastleigh — closest to N. Stoneham work
  if (pc.startsWith("SO50") || (!pc && area === "SO50")) return 10;
  // Banister / west of centre — neutral acceptable
  if (pc.startsWith("SO15 2")) return 5;
  // Central — penalised
  if (pc.startsWith("SO14 0") || pc.startsWith("SO14 6") ||
      pc.startsWith("SO14 7") || pc.startsWith("SO15 1")) return -5;
  // Shirley / Millbrook / Ocean Village / SO18 — too far
  if (pc.startsWith("SO15 3") || pc.startsWith("SO15 5") ||
      pc.startsWith("SO15 7") || pc.startsWith("SO15 8") ||
      pc.startsWith("SO14 1") || pc.startsWith("SO14 2") ||
      pc.startsWith("SO14 3") || pc.startsWith("SO14 5") ||
      pc.startsWith("SO18")) return -5;
  if (!pc && area === "SO18") return -5;
  return 0;
};

const greenRule: Rule = (r) => {
  if (r.near_green_space && /common/i.test(r.near_green_space)) return 15;
  return 0;
};

const epcRule: Rule = (r) => {
  if (r.epc === "A" || r.epc === "B") return 8;
  if (r.epc === "C") return 4;
  return 0;
};

const availabilityRule: Rule = (r) => {
  if (r.available_date && r.available_date > DEADLINE) return -10;
  return 0;
};

const studioPenaltyRule: Rule = (r) => {
  const isStudio = (r.listing_type ?? "").toLowerCase() === "studio";
  if (r.beds == null || isStudio) return -5;
  return 0;
};

export const RULES: Rule[] = [
  priceRule,
  furnishedRule,
  parkingRule,
  postcodeRule,
  greenRule,
  epcRule,
  availabilityRule,
  studioPenaltyRule,
];

/** Sum every scoring rule. Max ~103 today; check RULES if tuning. */
export function scoreListing(r: ScoreInput): number {
  let s = 0;
  for (const rule of RULES) s += rule(r);
  return s;
}
