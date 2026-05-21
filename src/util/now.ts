/** Single source of truth for the "now" timestamp format used everywhere. */
export function nowIso(): string {
  return new Date().toISOString().slice(0, 19);
}
