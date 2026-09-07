import { verify } from "argon2";
import type { Database } from "../db/client.js";
import { findPlayerByEmail } from "../players/queries.js";
import type { LoginInput } from "./schemas.js";
import type { PublicPlayer } from "./types.js";

// Not an account credential. Unknown emails still perform Argon2 verification,
// avoiding an immediate return that would make missing accounts much faster.
const dummyHash = "$argon2id$v=19$m=65536,p=4,t=3$NSza1gzBBLGlqWnJo57w7g$FH5lx9pQwiBRvcw25716w/kQYrX9JO75f9wd9p7twe4";

export type LoginResult =
  | { ok: true; player: PublicPlayer }
  | { ok: false; reason: "invalid_credentials" };

export async function login(db: Database, input: LoginInput): Promise<LoginResult> {
  const player = await findPlayerByEmail(db, input.email);
  const passwordMatches = await verify(player?.passwordHash ?? dummyHash, input.password);

  if (player === null || !passwordMatches) {
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
