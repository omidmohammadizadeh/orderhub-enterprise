import type { Config } from "jest";

const config: Config = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "^.+\\.(t|j)s$": ["ts-jest", { tsconfig: { module: "commonjs" } }],
  },
  testEnvironment: "node",
  moduleNameMapper: {
    "^@orderhub/shared(.*)$": "<rootDir>/../../../packages/shared/src$1",
    "^@orderhub/database(.*)$": "<rootDir>/../../../packages/database/src$1",
  },
  testTimeout: 10000,
};

export default config;
