import { describe, expect, test } from "bun:test";
import {
  parsePrice, parseBedsBaths, parseFurnished, parseParking,
  parsePostcodeArea, parsePostcodeFull, parseDeposit, parseEpc,
  parseAvailable, parseListingType,
} from "./field-parsers.ts";

describe("parsePrice", () => {
  test("strips commas", () => {
    expect(parsePrice("1,150")).toBe(1150);
    expect(parsePrice("950")).toBe(950);
  });
});

describe("parseBedsBaths", () => {
  test("'2 bed, 1 bath'", () => {
    expect(parseBedsBaths("2 bed, 1 bath")).toEqual({ beds: 2, baths: 1 });
  });
  test("missing", () => {
    expect(parseBedsBaths("")).toEqual({ beds: null, baths: null });
  });
});

describe("parseFurnished", () => {
  test("yes/no/optional/part/unclear", () => {
    expect(parseFurnished("Yes")).toBe("yes");
    expect(parseFurnished("No")).toBe("no");
    expect(parseFurnished("Optional")).toBe("optional");
    expect(parseFurnished("Part furnished")).toBe("part");
    expect(parseFurnished("not specified")).toBe("unclear");
    expect(parseFurnished("")).toBe("unclear");
  });
});

describe("parseParking", () => {
  test("none/allocated/driveway/permit/etc.", () => {
    expect(parseParking("Allocated parking")).toBe("allocated");
    expect(parseParking("Driveway")).toBe("driveway");
    expect(parseParking("Permit parking")).toBe("permit");
    expect(parseParking("No parking")).toBe("none");
    expect(parseParking("not available")).toBe("none");
    expect(parseParking("Off-street")).toBe("off-street");
    expect(parseParking("On-street")).toBe("on-street");
    expect(parseParking("not stated")).toBe("unclear");
  });
});

describe("parsePostcodeArea", () => {
  test("matches SO14-18 + SO50", () => {
    expect(parsePostcodeArea("SO17 1BJ")).toBe("SO17");
    expect(parsePostcodeArea("SO50 9NU")).toBe("SO50");
    expect(parsePostcodeArea("SO16 5AB")).toBe("SO16");
  });
  test("returns null for unknown outcodes", () => {
    expect(parsePostcodeArea("PO1 1AB")).toBeNull();
    expect(parsePostcodeArea("SO19 1XX")).toBeNull();
    expect(parsePostcodeArea("")).toBeNull();
  });
});

describe("parsePostcodeFull", () => {
  test("normalises whitespace", () => {
    expect(parsePostcodeFull("Address SO17 1BJ blah")).toBe("SO17 1BJ");
    expect(parsePostcodeFull("SO171BJ")).toBe("SO17 1BJ");
  });
});

describe("parseDeposit", () => {
  test("strips £ and commas", () => {
    expect(parseDeposit("£1,500")).toBe(1500);
    expect(parseDeposit("£1500.00")).toBe(1500);
  });
  test("returns null when no number", () => {
    expect(parseDeposit("ask agent")).toBeNull();
  });
});

describe("parseEpc", () => {
  test("returns the rating letter", () => {
    expect(parseEpc("C")).toBe("C");
    expect(parseEpc("EPC rating: B")).toBe("B");
  });
  test("returns null when pending/missing", () => {
    expect(parseEpc("not listed")).toBeNull();
    expect(parseEpc("pending")).toBeNull();
    expect(parseEpc("")).toBeNull();
  });
});

describe("parseListingType", () => {
  test("classifies", () => {
    expect(parseListingType("Studio flat")).toBe("studio");
    expect(parseListingType("3 bed maisonette")).toBe("maisonette");
    expect(parseListingType("House Share, Bevois")).toBe("houseshare");
    expect(parseListingType("Room in shared house")).toBe("houseshare");
    expect(parseListingType("Flat in Highfield")).toBe("flat");
  });
  test("null when unmatched", () => {
    expect(parseListingType("")).toBeNull();
  });
});

describe("parseAvailable", () => {
  test("'now' / immediate", () => {
    const r = parseAvailable("Available now");
    expect(r.iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  test("named-month date", () => {
    const r = parseAvailable("3 August 2026");
    expect(r.iso).toBe("2026-08-03");
  });
  test("UK dd/mm/yyyy", () => {
    const r = parseAvailable("03/08/2026");
    expect(r.iso).toBe("2026-08-03");
  });
});
