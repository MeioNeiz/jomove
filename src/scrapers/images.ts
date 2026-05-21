/**
 * Image URL filter. Drops floorplans / EPC certs / agent logos that
 * sometimes appear in the same gallery feed as the photos.
 *
 * Heuristic only — substring match on the URL. A floorplan whose URL
 * doesn't contain "floorplan" will sneak through; that's fine.
 */

const KILL_PATTERNS = [
  /floorplan/i,
  /floor[-_]?plan/i,
  /\bepc\b/i,
  /energy[-_]?rating/i,
  /branding/i,
  /logo/i,
  /agent[-_]?logo/i,
];

export function filterImages(urls: string[], maxImages = 5): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (!u || !u.startsWith("http")) continue;
    if (seen.has(u)) continue;
    if (KILL_PATTERNS.some(re => re.test(u))) continue;
    out.push(u);
    seen.add(u);
    if (out.length >= maxImages) break;
  }
  return out;
}
