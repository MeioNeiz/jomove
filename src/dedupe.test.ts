import { describe, expect, test } from "bun:test";
import { dedupeKey, directLine } from "./dedupe.ts";

describe("dedupeKey", () => {
  test("collapses portal-specific address prefixes", () => {
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

  test("strips agent ref blocks (Rightmove)", () => {
    const rm = dedupeKey("|Ref: R153042|, Shirley Road, Southampton, SO15 3EY", 925, "SO15");
    const ot = dedupeKey("Shirley Road, Southampton SO15", 925, "SO15");
    expect(rm).toBe(ot);
  });

  test("normalises Road / Rd / Street / St abbreviations", () => {
    expect(dedupeKey("12 Shirley Road",   925, "SO15"))
      .toBe(dedupeKey("12 Shirley Rd",    925, "SO15"));
    expect(dedupeKey("Anglesea Street",   1000, "SO14"))
      .toBe(dedupeKey("Anglesea St",      1000, "SO14"));
    expect(dedupeKey("Park Avenue",       950, "SO17"))
      .toBe(dedupeKey("Park Ave",         950, "SO17"));
  });

  test("strips leading house numbers (12 X Rd == X Rd)", () => {
    expect(dedupeKey("12 Portswood Rd",  1000, "SO17"))
      .toBe(dedupeKey("Portswood Rd",    1000, "SO17"));
    expect(dedupeKey("12a Portswood Rd", 1000, "SO17"))
      .toBe(dedupeKey("Portswood Rd",    1000, "SO17"));
  });

  test("ignores trailing Hampshire / Southampton suffixes", () => {
    expect(dedupeKey("Paignton Road, Hampshire SO16", 895, "SO16"))
      .toBe(dedupeKey("Paignton Rd, Southampton",     895, "SO16"));
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
