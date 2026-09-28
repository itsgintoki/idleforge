const maximumScore = BigInt(Number.MAX_SAFE_INTEGER);

export function toLeaderboardScore(lifetimeGoldEarned: string): number {
  if (!/^\d{1,24}\.\d{6}$/.test(lifetimeGoldEarned)) {
    throw new TypeError(
      'Invalid format: lifetimeGoldEarned must be 1-24 digits followed by "." and exactly 6 digits.'
    );
  }

  const fixedPointString = lifetimeGoldEarned.replace('.', '');

  const scoreBigInt = BigInt(fixedPointString);
  if (scoreBigInt > maximumScore) {
    throw new RangeError(
      `Score exceeds Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}).`
    );
  }

  return Number(scoreBigInt);
}

export function fromLeaderboardScore(rawScore: string): string {
  if (!/^\d+$/.test(rawScore)) {
    throw new TypeError("Invalid leaderboard score format");
  }

  const value = BigInt(rawScore);

  if (value > maximumScore) {
    throw new RangeError("Leaderboard score exceeds the safe integer ceiling");
  }

  const integerPart = value / 1_000_000n;
  const fractionalPart = value % 1_000_000n;

  return `${integerPart}.${fractionalPart.toString().padStart(6, "0")}`;
}
