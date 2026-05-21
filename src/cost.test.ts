import { describe, expect, test } from "bun:test";
import { computeCostAdjustment } from "./cost.ts";

describe("computeCostAdjustment", () => {
  test("bills included → −130", () => {
    const r = computeCostAdjustment({
      why_worth_a_look: "all bills included",
    });
    expect(r.delta).toBe(-130);
    expect(r.components.find(c => c.label === "bills incl")?.delta).toBe(-130);
  });

  test("water + heating partial inclusions accumulate", () => {
    const r = computeCostAdjustment({
      why_worth_a_look: "water included; heating included",
    });
    expect(r.delta).toBe(-85);
  });

  test("EPC C is the baseline (no adjustment)", () => {
    const r = computeCostAdjustment({ epc: "C" });
    expect(r.components.find(c => c.label.startsWith("EPC"))).toBeUndefined();
  });

  test("EPC A penalty/bonus is asymmetric — A is a bonus", () => {
    const r = computeCostAdjustment({ epc: "A" });
    expect(r.delta).toBe(-30);
  });

  test("EPC F adds £95", () => {
    const r = computeCostAdjustment({ epc: "F" });
    expect(r.delta).toBe(95);
  });

  test("council tax band D adds £22", () => {
    const r = computeCostAdjustment({
      caveats: "Council tax band D",
    });
    expect(r.delta).toBe(22);
  });

  test("user overrides remove auto + add custom", () => {
    const r = computeCostAdjustment({
      why_worth_a_look: "all bills included",
      overrides: {
        remove: ["bills incl"],
        add: [{ label: "cleaning", delta: 40 }],
      },
    });
    expect(r.delta).toBe(40);
    expect(r.components.find(c => c.label === "cleaning")?.source).toBe("user");
  });

  test("parking surcharge detected", () => {
    const r = computeCostAdjustment({
      caveats: "Parking is £50 pcm extra",
    });
    expect(r.components.some(c => c.label.includes("parking"))).toBeTrue();
  });
});
