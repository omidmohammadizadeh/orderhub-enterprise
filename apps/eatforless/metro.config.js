// Metro — this app is outside the pnpm workspace (own npm lockfile, like
// apps/driver), so it resolves packages from its own node_modules only. The
// one thing it reads from the monorepo is packages/shared/src/lib (pure
// pricing helpers, see babel.config.js), hence that watch folder.

const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const sharedLib = path.resolve(projectRoot, "..", "..", "packages", "shared", "src", "lib");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [sharedLib];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

module.exports = config;
