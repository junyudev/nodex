import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  nodeBuildOptimizationArguments,
  type NodeBuildMode,
} from "../config/node-build-optimization";
import {
  agentRuntimeBuildIdentity,
  agentRuntimeMetafileDigest,
  canReuseAgentRuntimeBuild,
  readAgentRuntimeBuildReceipt,
  withAgentRuntimeBuildLock,
} from "./agent-runtime-build-cache";
import { materializeAgentRuntimeNative } from "./agent-runtime-native";
import { immutableDirectoryDigest } from "./immutable-artifact-cache";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The execution process has its own Node bundle, outside Electron Main's cold path. Code
 * splitting keeps the per-session ACP bridge from loading the engine: `entry.mjs` only selects
 * a mode, and each mode loads its own chunk graph. It lives beside `out/main`, never inside it,
 * because the Main build empties `out/main` on every development start and hot rebuild.
 */
export function buildAgentRuntime(
  root = repositoryRoot,
  mode: NodeBuildMode = "production",
): "built" | "reused" {
  return withAgentRuntimeBuildLock(root, () => buildLockedAgentRuntime(root, mode));
}

function buildLockedAgentRuntime(root: string, mode: NodeBuildMode): "built" | "reused" {
  const output = join(root, "out/agent-runtime");
  const metafile = join(root, ".generated/agent-runtime-build.json");
  const receiptPath = join(root, ".generated/agent-runtime-build-receipt.json");
  const require = createRequire(join(root, "package.json"));
  const binary = require.resolve("esbuild/bin/esbuild");
  const sdk = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
  const native = materializeAgentRuntimeNative(root);
  const identityFor = (inputs: readonly string[]) =>
    agentRuntimeBuildIdentity({ root, binary, sdk, mode, inputs, native });
  const receipt = readAgentRuntimeBuildReceipt(receiptPath);
  const reusable = canReuseAgentRuntimeBuild(root);
  if (reusable && receipt) {
    try {
      if (
        receipt.identity === identityFor(receipt.inputs) &&
        receipt.output === immutableDirectoryDigest(output) &&
        receipt.metafile === agentRuntimeMetafileDigest(metafile)
      ) {
        return "reused";
      }
    } catch {
      // A missing input or damaged output needs a complete replacement build.
    }
  }

  const previousInputs = (receipt?.inputs ?? []).filter((file) => existsSync(resolve(root, file)));
  mkdirSync(join(root, "out"), { recursive: true });
  mkdirSync(join(root, ".generated"), { recursive: true });
  const temporaryRoot = mkdtempSync(join(root, "out/.agent-runtime-build-"));
  // Keep the bundle at its final directory depth so external sourcemap paths remain valid.
  const temporaryOutput = join(root, "out", `${basename(temporaryRoot)}-content`);
  const temporaryMetafile = join(temporaryRoot, "metafile.json");
  const temporaryReceipt = join(temporaryRoot, "receipt.json");
  const previousOutput = join(temporaryRoot, "previous");
  try {
    const { inputs, identity } = bundleWithStableInputs({
      previousInputs,
      identityFor,
      output: temporaryOutput,
      metafile: temporaryMetafile,
      bundle: () =>
        execFileSync(
          binary,
          [
            "packages/agent-runtime/src/nodex/entry.ts",
            "--bundle",
            "--splitting",
            "--platform=node",
            "--format=esm",
            "--target=node24",
            ...nodeBuildOptimizationArguments(mode),
            "--external:@anthropic-ai/claude-agent-sdk",
            "--external:@ff-labs/fff-node",
            "--external:node-pty",
            '--banner:js=import { createRequire as nodexCreateRequire } from "node:module"; const require = nodexCreateRequire(import.meta.url);',
            `--outdir=${temporaryOutput}`,
            "--out-extension:.js=.mjs",
            "--chunk-names=chunks/[name]-[hash]",
            `--metafile=${temporaryMetafile}`,
          ],
          { cwd: root, stdio: "inherit" },
        ),
    });
    // The SDK locates native assets relative to its module. Preserve that layout
    // beside the standalone process so Node never needs Electron's ASAR loader.
    const packagedSdk = join(temporaryOutput, "node_modules/@anthropic-ai/claude-agent-sdk");
    mkdirSync(dirname(packagedSdk), { recursive: true });
    cpSync(sdk, packagedSdk, { recursive: true });
    cpSync(native.packageRoot, join(temporaryOutput, "node_modules/node-pty"), { recursive: true });
    cpSync(native.manifestPath, join(temporaryOutput, "native-dependencies.json"));
    for (const notice of ["LICENSE.t3code", "UPSTREAM.json"])
      cpSync(join(root, "packages/agent-runtime", notice), join(temporaryOutput, notice));
    if (readFileSync(join(temporaryOutput, "entry.mjs")).length === 0) {
      throw new Error("Agent Runtime build did not produce an entrypoint");
    }
    if (identity !== identityFor(inputs)) {
      throw new Error("Agent Runtime inputs changed while bundling; run the build again");
    }
    writeFileSync(
      temporaryReceipt,
      `${JSON.stringify({
        identity,
        inputs,
        output: immutableDirectoryDigest(temporaryOutput),
        metafile: agentRuntimeMetafileDigest(temporaryMetafile),
      })}\n`,
    );
    // Directory renames expose only complete trees. Keep the last output for rollback
    // until its replacement has been published successfully.
    const previousMetafile = existsSync(metafile) ? readFileSync(metafile) : undefined;
    const previousReceipt = existsSync(receiptPath) ? readFileSync(receiptPath) : undefined;
    if (existsSync(output)) renameSync(output, previousOutput);
    try {
      renameSync(temporaryOutput, output);
      renameSync(temporaryMetafile, metafile);
      if (reusable) renameSync(temporaryReceipt, receiptPath);
      else rmSync(receiptPath, { force: true });
    } catch (error) {
      rmSync(output, { force: true, recursive: true });
      if (existsSync(previousOutput)) renameSync(previousOutput, output);
      restoreMetadata(metafile, previousMetafile);
      restoreMetadata(receiptPath, previousReceipt);
      throw error;
    }
    return "built";
  } finally {
    rmSync(temporaryOutput, { force: true, recursive: true });
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

/** Discover new imports before certifying a bundle against a complete pre-compilation snapshot. */
function bundleWithStableInputs(input: {
  readonly previousInputs: readonly string[];
  readonly identityFor: (inputs: readonly string[]) => string;
  readonly output: string;
  readonly metafile: string;
  readonly bundle: () => void;
}): { readonly inputs: readonly string[]; readonly identity: string } {
  let tracked = [...input.previousInputs].sort();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const identity = input.identityFor(tracked);
    input.bundle();
    const metadata = JSON.parse(readFileSync(input.metafile, "utf8")) as {
      readonly inputs: Record<string, unknown>;
    };
    const discovered = Object.keys(metadata.inputs).sort();
    if (discovered.length === 0) throw new Error("Agent Runtime build did not record any inputs");
    if (identity !== input.identityFor(tracked)) {
      throw new Error("Agent Runtime inputs changed while bundling; run the build again");
    }
    if (JSON.stringify(discovered) === JSON.stringify(tracked))
      return { inputs: tracked, identity };
    // A newly read file had no byte snapshot before this compilation. Discard that
    // result and compile again with the discovered graph covered by both snapshots.
    tracked = discovered;
    rmSync(input.output, { force: true, recursive: true });
    rmSync(input.metafile, { force: true });
  }
  throw new Error("Agent Runtime input graph kept changing while bundling; run the build again");
}

function restoreMetadata(path: string, contents: Buffer | undefined): void {
  rmSync(path, { force: true });
  if (contents) writeFileSync(path, contents);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--development")) {
    throw new Error("Usage: build-agent-runtime.ts [--development]");
  }
  const result = buildAgentRuntime(
    repositoryRoot,
    arguments_[0] === "--development" ? "development" : "production",
  );
  process.stdout.write(`Agent Runtime ${result}.\n`);
}
