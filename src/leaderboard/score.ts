const goldFormat = /^\d{1,24}\.\d{6}$/;

function assertGoldFormat(lifetimeGoldEarned: string): void {
  if (!goldFormat.test(lifetimeGoldEarned)) {
    throw new TypeError(
      'Invalid format: lifetimeGoldEarned must be 1-24 digits followed by "." and exactly 6 digits.',
    );
  }
}

export function toLeaderboardScore(lifetimeGoldEarned: string): number {
  assertGoldFormat(lifetimeGoldEarned);
  return Number(lifetimeGoldEarned);
}
