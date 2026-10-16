import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The execution process has its own Node bundle, outside Electron Main's cold path. Code
 * splitting keeps the per-session ACP bridge from loading the engine: `entry.mjs` only selects
 * a mode, and each mode loads its own chunk graph. It lives beside `out/main`, never inside it,
 * because the Main build empties `out/main` on every development start and hot rebuild.
 */
export function buildAgentRuntime(root = repositoryRoot): void {
  const output = join(root, "out/agent-runtime");
  rmSync(output, { recursive: true, force: true });
  execFileSync(
    "pnpm",
    [
      "exec",
      "esbuild",
      "packages/agent-runtime/src/nodex/entry.ts",
      "--bundle",
      "--splitting",
      "--platform=node",
      "--format=esm",
      "--target=node24",
      "--external:@anthropic-ai/claude-agent-sdk",
      "--external:@ff-labs/fff-node",
      '--banner:js=import { createRequire as nodexCreateRequire } from "node:module"; const require = nodexCreateRequire(import.meta.url);',
      "--outdir=out/agent-runtime",
      "--out-extension:.js=.mjs",
      "--chunk-names=chunks/[name]-[hash]",
      "--metafile=.generated/agent-runtime-build.json",
    ],
    { cwd: root, stdio: "inherit" },
  );
  // The SDK locates native assets relative to its module. Preserve that layout
  // beside the standalone process so Node never needs Electron's ASAR loader.
  const require = createRequire(join(root, "package.json"));
  const sdkRoot = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
  const packagedSdk = join(output, "node_modules/@anthropic-ai/claude-agent-sdk");
  mkdirSync(dirname(packagedSdk), { recursive: true });
  cpSync(sdkRoot, packagedSdk, { recursive: true });
  for (const notice of ["LICENSE.t3code", "UPSTREAM.json"])
    cpSync(join(root, "packages/agent-runtime", notice), join(output, notice));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  buildAgentRuntime();
