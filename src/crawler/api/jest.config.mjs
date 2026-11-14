export default {
  testEnvironment: "node",
  transform: {},
  testMatch: ["<rootDir>/src/__tests__/**/*.test.mjs"],
  collectCoverageFrom: ["dist/**/*.js", "!dist/index.js"],
  coverageProvider: "v8",
  projects: [
    { displayName: "unit", testMatch: ["<rootDir>/src/__tests__/unit/*.test.mjs"], transform: {} },
    { displayName: "integration", testMatch: ["<rootDir>/src/__tests__/integration/*.test.mjs"], transform: {} }
  ]
};
