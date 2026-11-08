import { describe, expect, it } from "vitest";
import { toLeaderboardScore } from "../../src/leaderboard/score.js";

describe("leaderboard score encoding", () => {
  it("maps exact gold to a float64 ranking score", () => {
    expect(toLeaderboardScore("0.000000")).toBe(0);
    expect(toLeaderboardScore("0.000001")).toBe(0.000001);
    expect(toLeaderboardScore("1.234567")).toBe(1.234567);
    expect(toLeaderboardScore("9007199254.740991")).toBe(9007199254.740991);
  });

  it("accepts totals above the old safe-integer ceiling", () => {
    expect(toLeaderboardScore("10000000000.000000")).toBe(10_000_000_000);
    expect(Number.isFinite(toLeaderboardScore("999999999999999999999999.000000"))).toBe(true);
  });

  it("rejects malformed values", () => {
    expect(() => toLeaderboardScore("1")).toThrow(TypeError);
    expect(() => toLeaderboardScore("1.00000")).toThrow(TypeError);
    expect(() => toLeaderboardScore("-1.000000")).toThrow(TypeError);
    expect(() => toLeaderboardScore("1e6")).toThrow(TypeError);
    expect(() => toLeaderboardScore(`${"1".repeat(25)}.000000`)).toThrow(TypeError);
  });
});
