const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
] as const;

export function parsePrice(s: string): number {
  return parseInt(s.replace(/,/g, ""), 10);
}

export function parseBedsBaths(s: string): { beds: number | null; baths: number | null } {
  if (!s) return { beds: null, baths: null };
  const sl = s.toLowerCase();
  const mb  = sl.match(/(\d+)\s*bed/);
  const mba = sl.match(/(\d+)\s*bath/);
  return {
    beds:  mb  ? parseInt(mb[1]!,  10) : null,
    baths: mba ? parseInt(mba[1]!, 10) : null,
  };
}

export function parseFurnished(s: string): string {
  if (!s) return "unclear";
  const sl = s.toLowerCase().trim();
  if (sl.startsWith("yes"))      return "yes";
  if (sl.startsWith("optional")) return "optional";
  if (sl.includes("part"))       return "part";
  if (sl.startsWith("no"))       return "no";
  return "unclear";
}

export function parseParking(s: string): string {
  if (!s) return "unclear";
  const sl = s.toLowerCase();
  if (sl.includes("no parking") || sl.includes("not available") ||
      sl.startsWith("not included") || sl.startsWith("none"))   return "none";
  if (sl.includes("allocated"))                                  return "allocated";
  if (sl.includes("driveway"))                                   return "driveway";
  if (sl.includes("off-street") || sl.includes("off street") ||
      sl.includes("residents"))                                  return "off-street";
  if (sl.includes("permit"))                                     return "permit";
  if (sl.includes("on-street") || sl.includes("on street"))      return "on-street";
  return "unclear";
}

export function parsePostcodeArea(s: string): string | null {
  if (!s) return null;
  const m = s.toUpperCase().match(/\bSO(1[4578])\b/);
  return m ? `SO${m[1]}` : null;
}

export function parsePostcodeFull(s: string): string | null {
  if (!s) return null;
  const m = s.toUpperCase().match(/\bSO\d{1,2}\s*\d[A-Z]{2}\b/);
  return m ? m[0].replace(/\s+/g, " ") : null;
}

export function parseDeposit(s: string): number | null {
  if (!s) return null;
  const m = s.match(/£\s?([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const v = parseFloat(m[1]!.replace(/,/g, ""));
  return Number.isFinite(v) ? Math.round(v) : null;
}

export function parseEpc(s: string): string | null {
  if (!s) return null;
  const sl = s.toLowerCase();
  if (sl.includes("not listed") || sl.includes("pending") ||
      sl.includes("being obtained")) return null;
  const m = s.toUpperCase().match(/\b([A-G])\b/);
  return m ? m[1]! : null;
}

export function parseAvailable(s: string): { raw: string | null; iso: string | null } {
  if (!s) return { raw: null, iso: null };
  const raw = s.trim();
  const sl = raw.toLowerCase();
  if (sl.includes("immediate") || sl.includes("available now") || sl === "now") {
    return { raw, iso: new Date().toISOString().slice(0, 10) };
  }
  const m1 = raw.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m1) {
    const month = m1[2]!.slice(0, 3).toLowerCase() as typeof MONTHS[number];
    const idx = MONTHS.indexOf(month);
    if (idx >= 0) {
      const d = new Date(Date.UTC(parseInt(m1[3]!, 10), idx, parseInt(m1[1]!, 10)));
      if (!isNaN(d.getTime())) return { raw, iso: d.toISOString().slice(0, 10) };
    }
  }
  const m2 = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m2) {
    const d = new Date(Date.UTC(
      parseInt(m2[3]!, 10),
      parseInt(m2[2]!, 10) - 1,
      parseInt(m2[1]!, 10),
    ));
    if (!isNaN(d.getTime())) return { raw, iso: d.toISOString().slice(0, 10) };
  }
  return { raw, iso: null };
}
