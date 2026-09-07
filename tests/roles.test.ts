import { expect, it } from "vitest";
import { roleSchema } from "../src/roles.js";

it("accepts only the supported player roles", () => {
  expect(roleSchema.parse("player")).toBe("player");
  expect(roleSchema.parse("admin")).toBe("admin");
  expect(roleSchema.safeParse("owner").success).toBe(false);
});
