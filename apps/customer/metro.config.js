// apps/customer is outside the pnpm workspace with its own npm node_modules.
// Resolve from there first so the monorepo root's different React / React
// Native versions are never picked up ahead of ours. (Hierarchical lookup has
// to stay on: npm nests some Expo packages, e.g. expo/node_modules/expo-asset.)
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];

module.exports = config;
