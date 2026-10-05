// Unit tests for the app's pure logic — the pieces that must be right and can
// be checked without a device (session policy, earnings maths, matchers).
// Deliberately node-environment: anything importing React Native belongs in a
// device test, not here.
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.spec.ts"],
};
