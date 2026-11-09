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
// Only this explicit variant includes diagnostics in its dependency graph.
if (process.env.APP_VARIANT === "tls-proof") {
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (
      moduleName === "./src/App" &&
      context.originModulePath === path.join(__dirname, "index.ts")
    ) {
      return {
        type: "sourceFile",
        filePath: path.join(__dirname, "diagnostics/tls-proof.tsx"),
      };
    }
    return context.resolveRequest(context, moduleName, platform);
  };
}

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  dtsFile: "./uniwind-types.d.ts",
});
