// Fail loudly if a test unexpectedly reaches a dependency it did not configure.
export const unusedPlayerDependencies = {
  collect: async () => { throw new Error("Collection not configured in this test"); },
  verifyAccessToken: () => { throw new Error("Token verification not configured in this test"); },
  findPlayerState: async () => { throw new Error("Player lookup not configured in this test"); },
};

export const unusedLoginDependencies = {
  ...unusedPlayerDependencies,
  login: async () => { throw new Error("Login not configured in this test"); },
  issueAccessToken: () => { throw new Error("Token issuance not configured in this test"); },
};
