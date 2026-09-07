import { z } from "zod";

export const playerRoles = ["player", "admin"] as const;
export const roleSchema = z.enum(playerRoles);
export type PlayerRole = z.infer<typeof roleSchema>;
