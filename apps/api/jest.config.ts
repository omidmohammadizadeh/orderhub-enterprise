import type { Config } from "jest";

const config: Config = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "^.+\\.(t|j)s$": ["ts-jest", { tsconfig: { module: "commonjs" } }],
  },
  collectCoverageFrom: ["**/*.(t|j)s"],
  coverageDirectory: "../coverage",
  testEnvironment: "node",
  setupFiles: ["<rootDir>/../test/jest-setup.ts"],
  moduleNameMapper: {
    "^@orderhub/shared(.*)$": "<rootDir>/../../packages/shared/src$1",
    "^@orderhub/database(.*)$": "<rootDir>/../../packages/database/src$1",
  },
  testTimeout: 10000,
};

export default config;
