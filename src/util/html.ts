/** HTML-escape for both text nodes and double-quoted attributes. */
export function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ENTITY_MAP: Record<string, string> = {
  "&nbsp;":  " ",
  "&#xA0;":  " ",
  "&amp;":   "&",
  "&pound;": "£",
  "&#xA3;":  "£",
  "&#39;":   "'",
  "&#x27;":  "'",
  "&apos;":  "'",
  "&quot;":  '"',
  "&lt;":    "<",
  "&gt;":    ">",
};
const ENTITY_RE = /&(?:nbsp|#xA0|amp|pound|#xA3|#39|#x27|apos|quot|lt|gt);/gi;

/** Decode the small set of HTML entities that show up in scraped portals. */
export function decodeEntities(s: string): string {
  return s.replace(ENTITY_RE, m => ENTITY_MAP[m.toLowerCase()] ?? m);
}

/** Strip tags + decode entities + collapse whitespace. */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Decode + preserve paragraph breaks (block close tags become newlines). */
export function decodeHtmlBlocks(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map(l => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
