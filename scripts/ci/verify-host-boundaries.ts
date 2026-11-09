import { build } from "esbuild";
import { resolve } from "node:path";

/** Resolve the real dependency graph so platform implementations cannot leak into the kernel. */
export async function verifyHostBoundaries(root = resolve(import.meta.dirname, "../..")) {
  await build({
    absWorkingDir: root,
    entryPoints: [
      "src/host/HostKernel.ts",
      "src/host/AgentRuntimeLive.ts",
      "src/host/WorkspaceRuntimeLive.ts",
      "src/host/ProviderConfigurationLive.ts",
      "src/host/CoreLive.ts",
      "src/host/HeadlessApplicationLive.ts",
      "src/host/serve-entry.ts",
    ],
    outdir: ".generated/host-boundary-check",
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "host-platform-boundary",
        setup(builder) {
          // A bundled asset resolves to its emitted path, never to code the kernel loads.
          builder.onResolve({ filter: /\?asset$/ }, (args) => ({
            path: args.path,
            external: true,
          }));
          builder.onLoad({ filter: /[/\\]platform[/\\]electron[/\\]/ }, (args) => ({
            errors: [{ text: `Host kernel loads a desktop platform Adapter: ${args.path}` }],
          }));
          builder.onResolve({ filter: /^(?:node:)?electron(?:\/|$)/ }, (args) => ({
            errors: [{ text: `Host kernel imports Electron through ${args.importer}` }],
          }));
        },
      },
    ],
  });
}

void verifyHostBoundaries().then(
  () => console.log("Host kernel resolves without Electron."),
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
