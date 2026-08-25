/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  clearMocks: true,
  restoreMocks: true,
  verbose: true,
  // The custom reporter mirrors Jest failures into logs/error.log using the exact
  // same envelope the runtime logger uses, so the self-healing agent can treat a
  // failed unit test as just another healable error event.
  reporters: ['default', '<rootDir>/tests/reporters/failureLogReporter.js'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', diagnostics: false }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
};
