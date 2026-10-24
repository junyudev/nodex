import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { assertPackagedAgentRuntimeNative } from "../agent-runtime-native-inventory.mjs";
import { materializeAgentRuntimeNative } from "../agent-runtime-native";
import { probeAcpManagement } from "./acp-management-probe";
import { withAgentRuntimeBuildLock } from "../agent-runtime-build-cache";

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const args = process.argv.slice(2);
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const home = value("--home");
  const reportPath = value("--report");
  if (!home || !isAbsolute(home) || !reportPath || !isAbsolute(reportPath))
    throw new Error("Pass absolute --home and --report paths");
  if (value("--target-platform") !== process.platform || value("--target-arch") !== process.arch)
    throw new Error("PTY verification requires a matching target platform and architecture host");
  mkdirSync(home, { recursive: true });
  const native = withAgentRuntimeBuildLock(root, () => materializeAgentRuntimeNative(root));
  if (!args.includes("--pty-only"))
    assertPackagedAgentRuntimeNative({
      sourceRoot: native.packageRoot,
      packagedRoot: join(root, "out/agent-runtime/node_modules/node-pty"),
    });
  rmSync(join(home, "observations.jsonl"), { force: true });
  const peer = join(home, "terminal fixture.mjs");
  cpSync(join(root, "scripts/testing/fixtures/acp-terminal-agent.mjs"), peer);
  const worker = join(home, "pty-worker.mjs");
  const require = createRequire(import.meta.url);
  execFileSync(
    require.resolve("esbuild/bin/esbuild"),
    [
      "packages/agent-runtime/scripts/acp-pty-probe-worker.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node24",
      "--external:node-pty",
      `--outfile=${worker}`,
    ],
    { cwd: root, stdio: "pipe" },
  );
  const ptyCapabilities = JSON.parse(
    execFileSync(native.node.executable, [worker, native.packageRoot, peer, home], {
      cwd: home,
      encoding: "utf8",
      timeout: 45_000,
    }),
  );
  const report = {
    generatedAt: new Date().toISOString(),
    boundary: args.includes("--pty-only") ? "staged-node-pty" : "built-runtime-management",
    node: native.node,
    ...(args.includes("--pty-only")
      ? {}
      : {
          entrySha256: createHash("sha256")
            .update(readFileSync(join(root, "out/agent-runtime/entry.mjs")))
            .digest("hex"),
        }),
    nodePty: { version: "1.1.0", artifactDigest: native.artifactDigest },
    capabilities: {
      ...ptyCapabilities,
      ...(args.includes("--pty-only")
        ? {}
        : await probeAcpManagement({ root, node: native.node, home, peer })),
    },
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
