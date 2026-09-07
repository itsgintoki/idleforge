import { argon2id, hash } from "argon2";
import type { Database } from "../db/client.js";
import { players, playerResources, type Player } from "../db/schema.js";
import type { SignupInput } from "./schemas.js";

export type PublicPlayer = Pick<Player, "id" | "email" | "role" | "createdAt">;
export type SignupResult =
  | { ok: true; player: PublicPlayer }
  | { ok: false; reason: "email_taken" };

export async function signup(db: Database, input: SignupInput): Promise<SignupResult> {
  const passwordHash = await hash(input.password, { type: argon2id });

  return db.transaction(async (tx): Promise<SignupResult> => {
    const [player] = await tx.insert(players).values({
      email: input.email,
      passwordHash,
      role: "player",
    }).onConflictDoNothing({ target: players.email }).returning({
      id: players.id,
      email: players.email,
      role: players.role,
      createdAt: players.createdAt,
    });

    if (!player) {
      return { ok: false, reason: "email_taken" };
    }

    await tx.insert(playerResources).values({ playerId: player.id });
    return { ok: true, player };
  });
}
