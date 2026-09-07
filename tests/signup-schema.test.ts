import { describe, expect, it } from "vitest";
import { signupSchema } from "../src/auth/schemas.js";

const validInput = {
  email: "sam@example.com",
  password: "a long test passphrase",
};

describe("signup input", () => {
  it("accepts valid credentials and normalizes the email", () => {
    expect(signupSchema.parse({ ...validInput, email: "  Sam@EXAMPLE.com  " }))
      .toEqual(validInput);
  });

  it("preserves password spaces and capitalization exactly", () => {
    const password = "  My Test Passphrase  ";
    expect(signupSchema.parse({ ...validInput, password }).password).toBe(password);
  });

  it.each([12, 128])("accepts a password at the %i-character boundary", (length) => {
    expect(signupSchema.safeParse({ ...validInput, password: "a".repeat(length) }).success)
      .toBe(true);
  });

  it.each(["", "a".repeat(11), "a".repeat(129), 123, null])(
    "rejects invalid password case %#",
    (password) => {
      expect(signupSchema.safeParse({ ...validInput, password }).success).toBe(false);
    },
  );

  it.each(["", "not-an-email", "sam@", 123, null])(
    "rejects invalid email case %#",
    (email) => {
      expect(signupSchema.safeParse({ ...validInput, email }).success).toBe(false);
    },
  );

  it.each([undefined, null, [], {}, { email: validInput.email }, { password: validInput.password }])(
    "rejects missing or malformed input case %#",
    (input) => {
      expect(signupSchema.safeParse(input).success).toBe(false);
    },
  );

  it("rejects a client-supplied role", () => {
    expect(signupSchema.safeParse({ ...validInput, role: "admin" }).success).toBe(false);
  });
});
