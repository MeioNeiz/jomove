const STRIP_PREFIX_RE =
  /^\s*(?:\d+\s*bed\s*(?:flat|apartment|maisonette)\s*,?\s*|flat\s+\d+\s*,?\s*|apartment\s+\d+\s*,?\s*|apt\s+\d+\s*,?\s*|\d+\s+)/i;

/** Heuristic key to merge the same listing across different portals. */
export function dedupeKey(address: string, price: number, postcodeArea: string | null): string {
  let a = address.toLowerCase();
  a = a.replace(STRIP_PREFIX_RE, "");
  a = a.replace(/,?\s*southampton\s*,?/i, "");
  a = a.replace(/,?\s*so\d{1,2}\s*\d?[a-z]{0,2}\s*$/i, "");
  a = a.trim().replace(/^,+|,+$/g, "").trim();
  const chunk = a.split(",")[0]!.trim();
  return `${chunk}|${postcodeArea ?? ""}|${price}`;
}

const DIRECT_STATIONS = ["central", "st denys", "swaythling", "airport parkway"] as const;

/** 1 if the rail field implies a direct Central ↔ Airport Parkway route, else 0. */
export function directLine(rail: string | undefined): number {
  if (!rail) return 0;
  const t = rail.toLowerCase();
  if (t.includes("not direct") || t.includes("netley") ||
      t.includes("requires change") || t.includes("needs a change")) return 0;
  if (t.includes("not on") && t.includes("direct")) return 0;
  return DIRECT_STATIONS.some(s => t.includes(s)) ? 1 : 0;
}
