import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  AGENT_RUNTIME_LAYOUT_VERSION,
  parseBundledAgentRuntimeMetadata,
} from "../../../src/shared/codex-runtime-metadata";

export interface AgentRuntimeFixture {
  readonly root: string;
  readonly executable: string;
  readonly metadataPath: string;
}

const defaultScenarioAppServerPath = path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs");

const writeScenarioAgentRuntime = (
  repositoryRoot: string,
  executableBody: string,
  version: string,
): AgentRuntimeFixture => {
  const runtimeRoot = path.join(repositoryRoot, ".generated/codex-runtime/agent-runtime");
  const executable = path.join(runtimeRoot, "bin/codex-app-server");
  const packagePath = path.join(runtimeRoot, "codex-package.json");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "codex-path"), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "codex-resources"), { recursive: true });
  const packageBody = JSON.stringify({
    entrypoint: "bin/codex-app-server",
    layoutVersion: 1,
    pathDir: "codex-path",
    resourcesDir: "codex-resources",
    target: `${process.arch}-${process.platform}`,
    variant: "codex-app-server",
    version,
  });
  fs.writeFileSync(executable, executableBody, { mode: 0o755 });
  fs.writeFileSync(packagePath, packageBody);
  fs.chmodSync(executable, 0o755);

  const artifacts = [
    ["bin/codex-app-server", executableBody, true],
    ["codex-package.json", packageBody, false],
  ] as const;
  const metadata = {
    releaseAsset: {
      archiveSha256: "0".repeat(64),
      archiveSize: 1,
      assetName: "codex-app-server-package-scenario.tar.gz",
      entrypointSha256: createHash("sha256").update(executableBody).digest("hex"),
      repository: "openai/codex",
      tag: `rust-v${version}`,
    },
    artifacts: artifacts.map(([artifactPath, body, isExecutable]) => ({
      executable: isExecutable,
      path: artifactPath,
      sha256: createHash("sha256").update(body).digest("hex"),
      size: Buffer.byteLength(body),
    })),
    appServerRuntimeVersion: version,
    entrypoint: "bin/codex-app-server",
    layoutVersion: AGENT_RUNTIME_LAYOUT_VERSION,
    packageManifest: JSON.parse(packageBody) as object,
    protocolSchemaFingerprint: "0".repeat(64),
    runtimeFamily: "codex-app-server",
    searchPaths: ["codex-path"],
    sourceRevision: {
      commit: "0".repeat(40),
      repository: "openai/codex",
      tag: `rust-v${version}`,
    },
    targetArch: process.arch,
    targetPlatform: process.platform,
    targetTriple: `${process.arch}-${process.platform}`,
  };
  if (!parseBundledAgentRuntimeMetadata(metadata)) {
    throw new Error("Scenario Agent runtime fixture is invalid");
  }
  const metadataPath = path.join(runtimeRoot, "agent-runtime.json");
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  return { root: runtimeRoot, executable, metadataPath };
};

export const prepareScenarioCodexAppServerRuntimeSync = (
  repositoryRoot: string,
  mockPeerPath: string,
  version = "0.145.0-alpha.15",
): AgentRuntimeFixture =>
  writeScenarioAgentRuntime(repositoryRoot, fs.readFileSync(mockPeerPath, "utf8"), version);

export const prepareScenarioAgentRuntimeSync = (repositoryRoot: string): AgentRuntimeFixture =>
  prepareScenarioCodexAppServerRuntimeSync(repositoryRoot, defaultScenarioAppServerPath);

export const prepareScenarioAgentRuntime = async (
  repositoryRoot: string,
): Promise<AgentRuntimeFixture> => prepareScenarioAgentRuntimeSync(repositoryRoot);
