import { describe, expect, it } from "vitest";
import {
  maximumBuildingLevel,
  priceForLevel,
  purchaseSchema,
} from "../../src/buildings/catalogue.js";

describe("building catalogue", () => {
  it("prices levels proportionally to the base price", () => {
    expect(priceForLevel("mine", 1)).toBe("100.000000");
    expect(priceForLevel("mine", 2)).toBe("200.000000");
    expect(priceForLevel("mine", 3)).toBe("300.000000");
    expect(priceForLevel("forge", 1)).toBe("500.000000");
    expect(priceForLevel("forge", 4)).toBe("2000.000000");
  });

  it("rejects levels outside the supported range", () => {
    expect(() => priceForLevel("mine", 0)).toThrow();
    expect(() => priceForLevel("mine", maximumBuildingLevel + 1)).toThrow();
    expect(() => priceForLevel("mine", 1.5)).toThrow();
  });

  it("accepts only supported buildings and no extra body fields", () => {
    expect(purchaseSchema.safeParse({ building: "mine" }).success).toBe(true);
    expect(purchaseSchema.safeParse({ building: "forge" }).success).toBe(true);
    expect(purchaseSchema.safeParse({ building: "farm" }).success).toBe(false);
    expect(purchaseSchema.safeParse({ building: "mine", price: 1 }).success).toBe(false);
  });
});
