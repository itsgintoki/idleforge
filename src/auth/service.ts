import { argon2id, hash, verify } from "argon2";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { players, playerResources, type PublicPlayer } from "../db/schema.js";
import { findPlayerByEmail } from "../players/queries.js";

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const signupSchema = z.strictObject({
  email: emailSchema,
  // Preserve the user's password exactly: no trimming or case conversion.
  password: z.string().min(12).max(128),
});

export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.strictObject({
  email: emailSchema,
  // Login verifies an existing password rather than reapplying signup's minimum.
  password: z.string().min(1).max(128),
});

export type LoginInput = z.infer<typeof loginSchema>;

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

// Not an account credential. Unknown emails still perform Argon2 verification,
// avoiding an immediate return that would make missing accounts much faster.
const dummyHash = "$argon2id$v=19$m=65536,p=4,t=3$NSza1gzBBLGlqWnJo57w7g$FH5lx9pQwiBRvcw25716w/kQYrX9JO75f9wd9p7twe4";

export type LoginResult =
  | { ok: true; player: PublicPlayer }
  | { ok: false; reason: "invalid_credentials" };

export async function login(db: Database, input: LoginInput): Promise<LoginResult> {
  const player = await findPlayerByEmail(db, input.email);
  const hashVerify = player?.passwordHash ?? dummyHash;
  const isValid = await verify(hashVerify, input.password);

  if (!player || !isValid) {
    return { ok: false, reason: "invalid_credentials" };
  }

  return {
    ok: true,
    player: {
      id: player.id,
      email: player.email,
      role: player.role,
      createdAt: player.createdAt,
    },
  };
}
