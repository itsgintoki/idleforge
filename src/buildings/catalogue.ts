import { z } from "zod";

export const buildingKeySchema = z.enum(["mine", "forge"]);
export type BuildingKey = z.infer<typeof buildingKeySchema>;
export const maximumBuildingLevel = 100;

// Whole-gold base prices; BigInt multiplication keeps upgrade pricing exact.
export const buildingCatalogue = {
  mine: { name: "Mine", basePrice: "100", rateIncrease: "1.000000" },
  forge: { name: "Forge", basePrice: "500", rateIncrease: "5.000000" },
} as const satisfies Record<BuildingKey, {
  name: string; basePrice: string; rateIncrease: string;
}>;

export const purchaseSchema = z.strictObject({ building: buildingKeySchema });
export type PurchaseInput = z.infer<typeof purchaseSchema>;
export const buildingStateSchema = z.object({
  building: buildingKeySchema,
  level: z.number().int().min(1).max(maximumBuildingLevel),
});

export function priceForLevel(building: BuildingKey, nextLevel: number): string {
  z.number().int().min(1).max(maximumBuildingLevel).parse(nextLevel);
  return `${BigInt(buildingCatalogue[building].basePrice) * BigInt(nextLevel)}.000000`;
}

// A key identifies one command, is case-sensitive, and is never normalized.
export const purchaseKeyPattern = "^[A-Za-z0-9_-]{1,128}$";
export const purchaseKeySchema = z.string().regex(new RegExp(purchaseKeyPattern));
export const purchaseRequestSchema = z.object({ body: purchaseSchema, key: purchaseKeySchema });
