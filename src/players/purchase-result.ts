import { z } from "zod";
import { buildingStateSchema } from "../buildings/catalogue.js";

const amount = z.string().regex(/^\d{1,24}\.\d{6}$/);
export const purchaseResultSchema = z.discriminatedUnion("ok", [
  buildingStateSchema.extend({
    ok: z.literal(true),
    spent: amount, credited: amount, balance: amount, lifetimeEarned: amount, rate: amount,
    // Fresh results have Date objects; persisted JSON contains ISO strings.
    collectedAt: z.union([z.date(), z.iso.datetime().pipe(z.coerce.date())]),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["player_not_found", "resource_not_found", "insufficient_funds", "max_level_reached", "idempotency_key_reused"]),
  }),
]);
export type PurchaseResult = z.infer<typeof purchaseResultSchema>;
