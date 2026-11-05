const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);
const workspace = path.resolve(__dirname, "../..");

// Keep the pnpm store and the protocol workspace visible without watching Desktop or Core.
config.watchFolders = [
  path.join(workspace, "node_modules"),
  path.join(workspace, "packages/mobile-protocol"),
];
config.resolver.unstable_enablePackageExports = true;

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  dtsFile: "./uniwind-types.d.ts",
});
