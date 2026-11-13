module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test', '<rootDir>/lambda/lib/__tests__'],
  testMatch: ['**/*.test.ts', '**/*.test.js'],
  // test/ holds TypeScript sources only. `tsc` compiles them to .js next to
  // the .ts files (gitignored); running those copies would run every suite
  // twice, and stale copies fail against current code.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/.*\\.js$'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  }
};
