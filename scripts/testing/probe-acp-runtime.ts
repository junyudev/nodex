import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { assertPackagedAgentRuntimeNative } from "../agent-runtime-native-inventory.mjs";
import { materializeAgentRuntimeNative } from "../agent-runtime-native";
import { probeAcpManagement } from "./acp-management-probe";
import { withAgentRuntimeBuildLock } from "../agent-runtime-build-cache";
import { openDevelopmentEnvironmentHome } from "../development-environment-home";
import { immutableDirectoryDigest, resolvePrimaryCheckoutRoot } from "../immutable-artifact-cache";

export function parseAcpRuntimeProbeArguments(
  args: readonly string[],
  host = { platform: process.platform as string, architecture: process.arch as string },
) {
  const { values } = parseArgs({
    args: [...args],
    options: {
      gate: { type: "boolean", default: false },
      "pty-only": { type: "boolean", default: false },
      home: { type: "string" },
      report: { type: "string" },
      "target-platform": { type: "string" },
      "target-arch": { type: "string" },
    },
  });
  if (values["target-platform"] !== host.platform || values["target-arch"] !== host.architecture)
    throw new Error("PTY verification requires a matching target platform and architecture host");
  if (values.gate) {
    if (host.platform !== "darwin" || host.architecture !== "arm64")
      throw new Error("The ACP release gate requires macOS arm64 execution");
    if (values["pty-only"] || values.home || values.report)
      throw new Error("The ACP gate always runs full management checks in a fresh owned home");
  } else if (
    !values.home ||
    !isAbsolute(values.home) ||
    !values.report ||
    !isAbsolute(values.report)
  ) {
    throw new Error("Pass absolute --home and --report paths");
  }
  return {
    gate: values.gate,
    ptyOnly: values["pty-only"],
    home: values.home,
    reportPath: values.report,
  };
}

export async function createAcpProbeEnvironment(
  root: string,
  options: ReturnType<typeof parseAcpRuntimeProbeArguments>,
) {
  const primary = resolvePrimaryCheckoutRoot(root);
  const slug = `acp-runtime-${randomUUID().slice(0, 8)}`;
  const home = options.home ?? join(primary, "runs.local", slug);
  const reportPath =
    options.reportPath ?? join(primary, "notes.local/artifacts", slug, "runtime.json");
  if (existsSync(reportPath)) throw new Error(`ACP probe report already exists: ${reportPath}`);
  mkdirSync(dirname(home), { recursive: true });
  // Refuse reused or active homes, including one left by a previous failed probe.
  mkdirSync(home, { mode: 0o700 });
  const owned = await openDevelopmentEnvironmentHome({ repositoryRoot: root, home });
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify({ status: "running", home: owned.root })}\n`, {
    flag: "wx",
  });
  return { home: owned.root, reportPath, manifest: owned.manifest };
}

async function probe(root: string, home: string, ptyOnly: boolean) {
  const native = withAgentRuntimeBuildLock(root, () => materializeAgentRuntimeNative(root));
  const runtimeRoot = join(root, "out/agent-runtime");
  const runtimeDigest = ptyOnly ? null : immutableDirectoryDigest(runtimeRoot);
  if (!ptyOnly)
    assertPackagedAgentRuntimeNative({
      sourceRoot: native.packageRoot,
      packagedRoot: join(root, "out/agent-runtime/node_modules/node-pty"),
    });
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
    boundary: ptyOnly ? "staged-node-pty" : "built-runtime-management",
    runtimeRoot: ptyOnly ? null : runtimeRoot,
    runtimeDigest,
    node: native.node,
    ...(ptyOnly
      ? {}
      : {
          entrySha256: createHash("sha256")
            .update(readFileSync(join(root, "out/agent-runtime/entry.mjs")))
            .digest("hex"),
        }),
    nodePty: { version: "1.1.0", artifactDigest: native.artifactDigest },
    capabilities: {
      ...ptyCapabilities,
      ...(ptyOnly ? {} : await probeAcpManagement({ root, node: native.node, home, peer })),
    },
  };
  if (!ptyOnly && runtimeDigest !== immutableDirectoryDigest(runtimeRoot))
    throw new Error("Agent Runtime bundle changed during ACP verification; run the gate again");
  return report;
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const options = parseAcpRuntimeProbeArguments(process.argv.slice(2));
  const environment = await createAcpProbeEnvironment(root, options);
  process.stdout.write(
    `ACP probe home: ${environment.home}\nACP probe report: ${environment.reportPath}\n`,
  );
  try {
    const report = {
      status: "passed",
      ...environment,
      ...(await probe(root, environment.home, options.ptyOnly)),
    };
    writeFileSync(environment.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    writeFileSync(
      environment.reportPath,
      `${JSON.stringify({ status: "failed", ...environment, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
    );
    throw error;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
