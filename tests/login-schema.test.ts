import { describe, expect, it } from "vitest";
import { loginSchema } from "../src/auth/schemas.js";

const credentials = { email: "sam@example.com", password: " My Exact Password " };

describe("login input", () => {
  it("normalizes email and preserves the password", () => {
    expect(loginSchema.parse({ ...credentials, email: " Sam@EXAMPLE.com " }))
      .toEqual(credentials);
  });

  it("allows a short nonempty password to reach credential verification", () => {
    expect(loginSchema.safeParse({ ...credentials, password: "wrong" }).success).toBe(true);
  });

  it.each(["", "a".repeat(129), null, 123])("rejects invalid password case %#", (password) => {
    expect(loginSchema.safeParse({ ...credentials, password }).success).toBe(false);
  });

  it.each([{}, null, [], { email: credentials.email }, { ...credentials, email: "invalid" },
    { ...credentials, role: "admin" }])("rejects malformed input case %#", (input) => {
    expect(loginSchema.safeParse(input).success).toBe(false);
  });
});
