import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalBundledAgentRuntimeMetadataJson,
  parseBundledAgentRuntimeMetadata,
  type BundledAgentRuntimeMetadata,
} from "../src/shared/codex-runtime-metadata";
import { resolveCodexRuntime } from "../src/main/codex/codex-runtime";
import {
  readCodexAppServerReleaseLock,
  type CodexAppServerReleaseLock,
} from "./agent-runtime-release-lock";

const canonicalRuntimeLockPath = fileURLToPath(
  new URL("../resources/agent-runtime/codex-app-server.lock.json", import.meta.url),
);

function readOption(argv: string[], option: string): string | null {
  const index = argv.indexOf(option);
  if (index < 0) return null;
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function readMacosTeamIdentifier(artifactPath: string): string {
  const verification = spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--strict", "--verbose=2", artifactPath],
    {
      encoding: "utf8",
    },
  );
  if (verification.error) {
    throw new Error(`Could not run codesign for ${artifactPath}: ${verification.error.message}`);
  }
  if (verification.status !== 0) {
    throw new Error(
      `Invalid code signature for ${artifactPath}: ${(verification.stderr || verification.stdout).trim()}`,
    );
  }

  const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", artifactPath], {
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(
      `Could not inspect code signature for ${artifactPath}: ${result.error.message}`,
    );
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(`Could not inspect code signature for ${artifactPath}: ${output.trim()}`);
  }
  const teamIdentifier = /^TeamIdentifier=(.+)$/mu.exec(output)?.[1]?.trim();
  if (!teamIdentifier || teamIdentifier === "not set") {
    throw new Error(`Expected ${artifactPath} to have a Developer ID team identifier`);
  }
  return teamIdentifier;
}

function readMacosArchitectures(artifactPath: string): string[] {
  const result = spawnSync("/usr/bin/lipo", ["-archs", artifactPath], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`Could not run lipo for ${artifactPath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Could not inspect architectures for ${artifactPath}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout
    .trim()
    .split(/\s+/u)
    .filter((entry) => entry.length > 0);
}

function readRuntimeMetadata(metadataPath: string): BundledAgentRuntimeMetadata {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    throw new Error(`Invalid bundled Agent runtime metadata at ${metadataPath}`);
  }
  const metadata = parseBundledAgentRuntimeMetadata(value);
  if (!metadata) {
    throw new Error(`Invalid bundled Agent runtime metadata at ${metadataPath}`);
  }
  return metadata;
}

export function assertCodexRuntimeMatchesReleaseLock(
  metadata: BundledAgentRuntimeMetadata,
  lock: CodexAppServerReleaseLock,
): void {
  if (
    metadata.targetPlatform !== "darwin" ||
    (metadata.targetArch !== "arm64" && metadata.targetArch !== "x64")
  ) {
    throw new Error("Bundled Codex runtime target is unsupported by the release lock");
  }
  const build = lock.builds[`darwin-${metadata.targetArch}`];
  const metadataSha256 = createHash("sha256")
    .update(canonicalBundledAgentRuntimeMetadataJson(metadata))
    .digest("hex");
  const entrypoint = metadata.artifacts.find(({ path }) => path === metadata.entrypoint);
  const expectedArtifactPaths = [
    ...lock.requiredArtifacts,
    "third-party/codex/LICENSE",
    "third-party/codex/NOTICE",
  ];
  const artifactPaths = metadata.artifacts.map(({ path }) => path);
  if (
    metadataSha256 !== build.runtimeMetadataSha256 ||
    entrypoint?.sha256 !== build.entrypointSha256 ||
    artifactPaths.length !== expectedArtifactPaths.length ||
    expectedArtifactPaths.some((path) => !artifactPaths.includes(path))
  ) {
    throw new Error(
      `Bundled Codex runtime does not match the canonical ${lock.upstream.tag} release lock`,
    );
  }
}

export function verifyCodexRuntime(input: {
  requireBrowserRuntime?: boolean;
  resourcesPath: string;
  verifyMacosSignatures: boolean;
}): void {
  const runtime = resolveCodexRuntime({
    isPackaged: true,
    resourcesPath: input.resourcesPath,
  });
  const versionResult = spawnSync(runtime.binaryPath, ["--version"], { encoding: "utf8" });
  if (versionResult.error) {
    throw new Error(`Could not execute bundled agent runtime: ${versionResult.error.message}`);
  }
  if (versionResult.status !== 0) {
    throw new Error(
      `Bundled agent runtime failed to report its version: ${versionResult.stderr.trim()}`,
    );
  }
  if (!runtime.version || !versionResult.stdout.includes(runtime.version)) {
    throw new Error(
      `Bundled agent runtime version ${versionResult.stdout.trim()} did not match runtime metadata ${runtime.version ?? "<missing>"}`,
    );
  }
  if (input.requireBrowserRuntime && runtime.browserRuntime.status === "unavailable") {
    throw new Error(`Bundled Browser runtime is unavailable: ${runtime.browserRuntime.message}`);
  }

  if (!runtime.metadataPath) {
    throw new Error("Bundled agent runtime metadata path is unavailable");
  }
  const metadata = readRuntimeMetadata(runtime.metadataPath);
  const lock = readCodexAppServerReleaseLock(canonicalRuntimeLockPath);
  assertCodexRuntimeMatchesReleaseLock(metadata, lock);

  if (input.verifyMacosSignatures) {
    const runtimeRoot = input.resourcesPath;
    for (const artifact of metadata.artifacts) {
      if (!artifact.executable) continue;
      const artifactPath = join(runtimeRoot, ...artifact.path.split("/"));
      const artifactTeamIdentifier = readMacosTeamIdentifier(artifactPath);
      if (artifactTeamIdentifier !== lock.upstream.signingTeamId) {
        throw new Error(
          `Expected ${artifactPath} to retain official OpenAI team ${lock.upstream.signingTeamId}; ` +
            `found ${artifactTeamIdentifier}`,
        );
      }
    }
    if (runtime.browserRuntime.status === "available") {
      const { bundle } = runtime.browserRuntime;
      const browserRuntimeTeamIdentifier = bundle.manifest.peerAuthorization.signingTeamId;
      const computerUseCapability = bundle.manifest.capabilities.computerUse;
      for (const artifact of bundle.manifest.artifacts) {
        if (artifact.kind === "data" || artifact.architecture === "any") continue;
        const artifactPath = join(bundle.rootPath, ...artifact.path.split("/"));
        const expectedArchitecture = bundle.manifest.targetArch === "x64" ? "x86_64" : "arm64";
        const architectures = readMacosArchitectures(artifactPath);
        const architectureMatches =
          artifact.architecture === "universal"
            ? architectures.includes("arm64") && architectures.includes("x86_64")
            : architectures.length === 1 && architectures[0] === expectedArchitecture;
        if (!architectureMatches) {
          throw new Error(
            `Browser runtime artifact architecture does not match its manifest: ${artifactPath}`,
          );
        }
        const artifactTeamIdentifier = readMacosTeamIdentifier(artifactPath);
        const expectedTeamIdentifier =
          computerUseCapability.status === "available" &&
          artifact.path.startsWith(`${computerUseCapability.appBundle}/`)
            ? computerUseCapability.signingTeamId
            : browserRuntimeTeamIdentifier;
        if (artifactTeamIdentifier !== expectedTeamIdentifier) {
          throw new Error(
            `Expected ${artifactPath} to retain desktop tool team ${expectedTeamIdentifier}; ` +
              `found ${artifactTeamIdentifier}`,
          );
        }
      }
    }
  }

  process.stdout.write(`Verified Codex app-server runtime ${runtime.version}\n`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const resourcesPath = readOption(argv, "--resources-path");
  if (!resourcesPath) {
    throw new Error(
      "Usage: verify-codex-runtime.ts --resources-path <Electron Resources> " +
        "[--verify-macos-signatures] [--require-browser-runtime]",
    );
  }
  verifyCodexRuntime({
    resourcesPath: resolve(resourcesPath),
    requireBrowserRuntime: argv.includes("--require-browser-runtime"),
    verifyMacosSignatures: argv.includes("--verify-macos-signatures"),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
