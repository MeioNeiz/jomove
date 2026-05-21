import { describe, expect, test } from "bun:test";
import { scoreListing, type ScoreInput } from "./score.ts";

const base: ScoreInput = {
  price_pcm:        950,
  furnished_status: "yes",
  parking_status:   "off-street",
  postcode_full:    "SO17 1BJ",
  postcode_area:    "SO17",
  near_green_space: "Southampton Common",
  epc:              "C",
  available_date:   "2026-06-01",
  beds:             2,
  listing_type:     "flat",
};

describe("scoreListing", () => {
  test("Highfield + Common + furnished + parking + price + EPC C", () => {
    // 15 (price 950) + 15 (furnished) + 10 (parking) + 25 (SO17 1) +
    // 15 (Common) + 4 (EPC C) + 0 + 0 = 84
    expect(scoreListing(base)).toBe(84);
  });

  test("studio penalty applies", () => {
    expect(scoreListing({ ...base, listing_type: "studio" })).toBe(84 - 5);
  });

  test("SO18 penalises", () => {
    expect(scoreListing({
      ...base,
      postcode_full: "SO18 2QQ", postcode_area: "SO18",
    })).toBe(84 - 25 - 5); // lose SO17 1 (+25), gain SO18 (-5)
  });

  test("available after deadline subtracts 10", () => {
    expect(scoreListing({ ...base, available_date: "2027-01-01" })).toBe(84 - 10);
  });

  test("price > 1100 → 0 price contribution", () => {
    expect(scoreListing({ ...base, price_pcm: 1150 })).toBe(84 - 15);
  });
});
