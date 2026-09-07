import type { Player } from "../db/schema.js";

export type PublicPlayer = Pick<Player, "id" | "email" | "role" | "createdAt">;
