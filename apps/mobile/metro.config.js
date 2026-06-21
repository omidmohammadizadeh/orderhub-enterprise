// Metro bundler config — Expo SDK 51.
//
// Standard config that resolves modules from this project's
// node_modules first, then the monorepo root. This stays compatible
// with EAS Build (which only uploads apps/mobile and runs install
// locally) AND with local `expo start` from inside the monorepo
// (which uses pnpm's symlinked layout).

const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..", "..");

const config = getDefaultConfig(projectRoot);

// 1. Watch all files within the monorepo so hot-reload picks up edits
//    to shared packages too (only relevant for local dev).
config.watchFolders = [workspaceRoot];

// 2. Look for modules in this project's node_modules first, then the
//    repo root. On EAS the workspaceRoot path won't exist; Metro just
//    skips the missing dir, no error.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// 3. Disable Metro's hierarchical lookup so it doesn't accidentally
//    resolve a package from a parent that doesn't have it (which
//    causes confusing "module not found" errors at runtime).
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
