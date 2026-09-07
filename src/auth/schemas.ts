import { z } from "zod";

// IdleForge treats email addresses as case-insensitive account identifiers.
export const signupSchema = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  // Preserve the user's password exactly: no trimming or case conversion.
  password: z.string().min(12).max(128),
});

export type SignupInput = z.infer<typeof signupSchema>;
