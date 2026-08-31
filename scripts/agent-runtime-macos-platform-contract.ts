import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";
import { CODEX_APP_SERVER_REQUIRED_ARTIFACTS } from "./agent-runtime-release-lock";

export type AgentRuntimeMacosTargetArch = "arm64" | "x64";
export const AGENT_RUNTIME_PRODUCT_MINIMUM_MACOS = "15.0" as const;

export type AgentRuntimeMacosPlatformContractInput = {
  productMinimumMacos: string;
  requiredArtifacts: readonly string[];
  runtimeRoot: string;
  targetArch: AgentRuntimeMacosTargetArch;
};

export type AgentRuntimeMacosPlatformContractVerifier = (
  input: AgentRuntimeMacosPlatformContractInput,
) => void;

export type AgentRuntimeMacosExecutableInspection = {
  artifactPath: string;
  lipoOutput: string;
  otoolOutput: string;
};

export type AgentRuntimeArtifactMode = {
  artifactPath: string;
  executable: boolean;
};

const REQUIRED_MACH_O_EXECUTABLES = new Set<string>(CODEX_APP_SERVER_REQUIRED_ARTIFACTS.slice(1));

function parseMacosVersion(value: string, label: string): readonly number[] {
  if (!/^\d+(?:\.\d+){0,2}$/u.test(value)) {
    throw new Error(`Invalid ${label} version: ${value}`);
  }
  return value.split(".").map(Number);
}

export function compareMacosVersions(left: string, right: string): number {
  const leftParts = parseMacosVersion(left, "minimum macOS");
  const rightParts = parseMacosVersion(right, "product minimum macOS");
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function assertAgentRuntimeMacosArtifactModes(
  artifacts: readonly AgentRuntimeArtifactMode[],
): void {
  for (const artifact of artifacts) {
    if (REQUIRED_MACH_O_EXECUTABLES.has(artifact.artifactPath) && !artifact.executable) {
      throw new Error(`Agent runtime Mach-O artifact is not executable: ${artifact.artifactPath}`);
    }
  }
}

export function parseLipoArchitectures(output: string): string[] {
  const architectures = output.trim().split(/\s+/u).filter(Boolean);
  if (
    architectures.length === 0 ||
    architectures.some((value) => !/^[A-Za-z0-9_]+$/u.test(value))
  ) {
    throw new Error(`Invalid lipo architecture output: ${output.trim() || "<empty>"}`);
  }
  return architectures;
}

export function parseOtoolMinimumMacosVersion(output: string): string {
  const versions: string[] = [];
  let command: "build-version" | "version-min" | null = null;
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("cmd ")) {
      command = trimmed === "cmd LC_BUILD_VERSION" ? "build-version" : null;
      if (trimmed === "cmd LC_VERSION_MIN_MACOSX") command = "version-min";
      continue;
    }
    const match =
      command === "build-version"
        ? /^minos\s+(\d+(?:\.\d+){0,2})$/u.exec(trimmed)
        : command === "version-min"
          ? /^version\s+(\d+(?:\.\d+){0,2})$/u.exec(trimmed)
          : null;
    if (match?.[1]) {
      versions.push(match[1]);
      command = null;
    }
  }
  if (versions.length !== 1) {
    throw new Error(`Expected one Mach-O minimum macOS version, found ${String(versions.length)}`);
  }
  return versions[0]!;
}

/**
 * Applies the platform contract to already-captured command output. Keeping this function pure
 * makes architecture and deployment-target policy testable without depending on host tools.
 */
export function assertAgentRuntimeMacosPlatformContract(input: {
  inspections: readonly AgentRuntimeMacosExecutableInspection[];
  productMinimumMacos: string;
  targetArch: AgentRuntimeMacosTargetArch;
}): void {
  parseMacosVersion(input.productMinimumMacos, "product minimum macOS");
  const expectedArchitecture = input.targetArch === "arm64" ? "arm64" : "x86_64";
  for (const inspection of input.inspections) {
    const architectures = parseLipoArchitectures(inspection.lipoOutput);
    if (architectures.length !== 1 || architectures[0] !== expectedArchitecture) {
      throw new Error(
        `Agent runtime architecture mismatch for ${inspection.artifactPath}: ` +
          `expected only ${expectedArchitecture}, found ${architectures.join(", ")}`,
      );
    }
    const minimumMacos = parseOtoolMinimumMacosVersion(inspection.otoolOutput);
    if (compareMacosVersions(minimumMacos, input.productMinimumMacos) > 0) {
      throw new Error(
        `Agent runtime ${inspection.artifactPath} requires macOS ${minimumMacos}, ` +
          `newer than the product minimum ${input.productMinimumMacos}`,
      );
    }
  }
}

function inspectExecutable(
  runtimeRoot: string,
  artifactPath: string,
): AgentRuntimeMacosExecutableInspection {
  const absolutePath = path.join(runtimeRoot, ...artifactPath.split("/"));
  return {
    artifactPath,
    lipoOutput: execFileSync("/usr/bin/lipo", ["-archs", absolutePath], { encoding: "utf8" }),
    otoolOutput: execFileSync("/usr/bin/otool", ["-l", absolutePath], { encoding: "utf8" }),
  };
}

export const verifyAgentRuntimeMacosPlatformContract: AgentRuntimeMacosPlatformContractVerifier = (
  input,
) => {
  const artifacts = input.requiredArtifacts.map((artifactPath) => {
    const absolutePath = path.join(input.runtimeRoot, ...artifactPath.split("/"));
    const metadata = lstatSync(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Agent runtime platform artifact is not a regular file: ${artifactPath}`);
    }
    return { artifactPath, executable: (metadata.mode & 0o111) !== 0 };
  });
  assertAgentRuntimeMacosArtifactModes(artifacts);
  const inspections = artifacts.flatMap(({ artifactPath, executable }) =>
    executable ? [inspectExecutable(input.runtimeRoot, artifactPath)] : [],
  );
  assertAgentRuntimeMacosPlatformContract({
    inspections,
    productMinimumMacos: input.productMinimumMacos,
    targetArch: input.targetArch,
  });
};
