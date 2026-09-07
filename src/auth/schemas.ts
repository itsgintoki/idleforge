import { z } from "zod";

// IdleForge treats email addresses as case-insensitive account identifiers.
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
