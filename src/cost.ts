import type { CostAdjustment, CostComponent } from "./template.ts";

/**
 * Heuristic "true monthly cost" adjustment relative to the headline rent.
 *
 * Baseline (a standard flat) assumes:
 *   - Tenant pays utilities (electric + gas + water), broadband, council tax
 *   - Parking is either free on-street or a minor permit
 *   - EPC C (median in the dataset)
 *
 * Adjustments subtract when the listing covers something the baseline
 * doesn't (e.g. bills included) and add when there's an explicit extra
 * (e.g. paid parking, poor EPC).
 *
 * Furnishing is intentionally excluded — the user noted that furnishing
 * quality varies wildly and a flat number would over- or under-value
 * listings unfairly.
 */
export function computeCostAdjustment(input: {
  why_worth_a_look?: string | null;
  caveats?:          string | null;
  parking_raw?:      string | null;
  epc?:              string | null;
}): CostAdjustment {
  const text = [input.why_worth_a_look, input.caveats, input.parking_raw]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const components: CostComponent[] = [];
  let billsCoveredFully = false;

  // "all bills included" / "bills inc"
  if (/\b(?:all\s+)?bills\s+(?:inc(?:luded|l|\.)?\b)/.test(text) ||
      /\binc(?:luded|l|\.)?\s+bills?\b/.test(text)) {
    components.push({ label: "bills incl", delta: -130 });
    billsCoveredFully = true;
  }

  // Partial inclusions (skip if fully covered already)
  if (!billsCoveredFully) {
    if (/\bwater\s+(?:rates?\s+)?(?:inc(?:luded|l|\.)?|are\s+inc(?:luded|l|\.)?)\b/.test(text) ||
        /\binc(?:luded|l|\.)?\s+water\b/.test(text)) {
      components.push({ label: "water incl", delta: -25 });
    }
    if (/\bheating\s+(?:inc(?:luded|l|\.)?|is\s+inc(?:luded|l|\.)?)\b/.test(text)) {
      components.push({ label: "heating incl", delta: -60 });
    }
    if (/\b(?:broadband|wi-?fi|internet)\s+(?:inc(?:luded|l|\.)?|is\s+inc(?:luded|l|\.)?)\b/.test(text) ||
        /\binc(?:luded|l|\.)?\s+(?:broadband|wi-?fi|internet)\b/.test(text)) {
      components.push({ label: "wifi incl", delta: -30 });
    }
  }

  // Surcharges — look for "£X (pcm|extra|per month) ... <thing>" patterns
  const surchargeNear = (token: RegExp): number | null => {
    const re = new RegExp(
      "(?:" + token.source + ")[^.]{0,60}£\\s*(\\d+(?:\\.\\d+)?)\\s*(?:pcm|/m|per\\s*month|monthly|extra|surcharge)|" +
      "£\\s*(\\d+(?:\\.\\d+)?)\\s*(?:pcm|/m|per\\s*month|monthly|extra|surcharge)[^.]{0,30}(?:" + token.source + ")",
      "i"
    );
    const m = text.match(re);
    if (!m) return null;
    const v = Number(m[1] ?? m[2]);
    return Number.isFinite(v) ? v : null;
  };

  const parkingSurcharge = surchargeNear(/parking|car\s*park|car\s*space|bay/);
  if (parkingSurcharge !== null) {
    components.push({ label: `+£${parkingSurcharge} parking`, delta: parkingSurcharge });
  }
  const waterSurcharge = surchargeNear(/water/);
  if (waterSurcharge !== null &&
      !components.some(c => c.label === "water incl")) {
    components.push({ label: `+£${waterSurcharge} water`, delta: waterSurcharge });
  }

  // EPC heating cost relative to C baseline
  const epc = input.epc?.toUpperCase();
  if (epc === "A" || epc === "B") components.push({ label: `EPC ${epc}`,    delta: -30 });
  else if (epc === "D")            components.push({ label: "EPC D",        delta:  20 });
  else if (epc === "E")            components.push({ label: "EPC E",        delta:  55 });
  else if (epc === "F" || epc === "G") components.push({ label: `EPC ${epc}`, delta: 95 });

  // Council tax band — band B treated as baseline
  const ctMatch = text.match(/council\s*tax\s*band\s*([a-h])\b/i);
  if (ctMatch) {
    const band = ctMatch[1]!.toUpperCase();
    const ctAdj: Record<string, number> = {
      A: -15, B: 0, C: 10, D: 22, E: 38, F: 55, G: 75, H: 100,
    };
    const adj = ctAdj[band];
    if (adj !== undefined && adj !== 0) {
      components.push({ label: `CT band ${band}`, delta: adj });
    }
  }

  const delta = components.reduce((sum, c) => sum + c.delta, 0);
  return { delta, components };
}
