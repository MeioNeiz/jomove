import { describe, expect, test } from "bun:test";
import { dedupeKey, directLine } from "./dedupe.ts";

describe("dedupeKey", () => {
  test("collapses portal-specific address prefixes", () => {
    // "1 bed flat, ..." and "Flat 3, ..." prefixes strip cleanly so the same
    // listing keyed across portals matches.
    const a = dedupeKey("1 bed flat, Highfield Road", 950, "SO17");
    const b = dedupeKey("Flat 3, Highfield Road", 950, "SO17");
    expect(a).toBe(b);
  });

  test("strips Southampton + outcode suffix", () => {
    const a = dedupeKey("12 Portswood Rd, Southampton, SO17 2NQ", 1000, "SO17");
    const b = dedupeKey("12 Portswood Rd", 1000, "SO17");
    expect(a).toBe(b);
  });

  test("different prices → different keys", () => {
    expect(dedupeKey("X", 900, "SO17")).not.toBe(dedupeKey("X", 1000, "SO17"));
  });
});

describe("directLine", () => {
  test("Southampton Central is direct", () => {
    expect(directLine("Southampton Central direct")).toBe(1);
  });

  test("Netley requires a change", () => {
    expect(directLine("Netley (change at St Denys)")).toBe(0);
  });

  test('"not direct" beats the station match', () => {
    expect(directLine("Not direct: change at Central")).toBe(0);
  });

  test("undefined returns 0", () => {
    expect(directLine(undefined)).toBe(0);
  });
});
