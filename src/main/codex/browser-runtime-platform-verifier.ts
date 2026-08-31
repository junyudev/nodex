import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { BrowserRuntimePlatformArtifactVerifier } from "./browser-runtime-bundle";

type CommandReader = (command: string, args: string[]) => string;

const PRODUCT_MINIMUM_MACOS = "15.0";

const parseVersion = (value: string): readonly number[] | null =>
  /^\d+(?:\.\d+){0,2}$/u.test(value) ? value.split(".").map(Number) : null;

export function parseMachOMinimumMacosVersion(output: string): string | null {
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
    if (!match?.[1]) continue;
    versions.push(match[1]);
    command = null;
  }
  return versions.length === 1 ? versions[0]! : null;
}

const compareVersions = (left: string, right: string): number | null => {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
};

function defaultCommandReader(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${String(result.status)}`);
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function isMachO(filePath: string): boolean {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) return false;
    const magic = header.readUInt32BE(0);
    return (
      magic === 0xfeedface ||
      magic === 0xfeedfacf ||
      magic === 0xcefaedfe ||
      magic === 0xcffaedfe ||
      magic === 0xcafebabe ||
      magic === 0xbebafeca ||
      magic === 0xcafebabf ||
      magic === 0xbfbafeca
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

function readTeamIdentifier(filePath: string, run: CommandReader): string | null {
  try {
    const output = run("/usr/bin/codesign", ["-dv", "--verbose=4", filePath]);
    return /^TeamIdentifier=(.+)$/mu.exec(output)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export function createBrowserRuntimePlatformArtifactVerifier(
  options: {
    platform?: NodeJS.Platform;
    runCommand?: CommandReader;
  } = {},
): BrowserRuntimePlatformArtifactVerifier {
  const platform = options.platform ?? process.platform;
  const run = options.runCommand ?? defaultCommandReader;
  return ({ artifact, artifactPath, manifest }) => {
    if (platform !== manifest.targetPlatform) {
      return `runtime target ${manifest.targetPlatform} cannot be verified on ${platform}`;
    }
    if (platform !== "darwin") {
      return `Browser runtime platform verification is unavailable on ${platform}`;
    }
    if (!isMachO(artifactPath)) {
      return artifact.architecture === "any"
        ? null
        : "architecture-specific artifact is not Mach-O";
    }

    let architectures: string[];
    try {
      architectures = run("/usr/bin/lipo", ["-archs", artifactPath]).split(/\s+/u).filter(Boolean);
    } catch {
      return "could not inspect Mach-O architecture";
    }
    const expectedArch = manifest.targetArch === "x64" ? "x86_64" : "arm64";
    if (!architectures.includes(expectedArch)) {
      return `Mach-O artifact does not contain ${expectedArch}`;
    }
    let minimumMacos: string | null;
    try {
      minimumMacos = parseMachOMinimumMacosVersion(
        run("/usr/bin/otool", ["-arch", expectedArch, "-l", artifactPath]),
      );
    } catch {
      minimumMacos = null;
    }
    if (!minimumMacos) return "could not inspect Mach-O minimum macOS version";
    if (compareVersions(minimumMacos, PRODUCT_MINIMUM_MACOS) === 1) {
      return (
        `Mach-O artifact requires macOS ${minimumMacos}, newer than the product minimum ` +
        PRODUCT_MINIMUM_MACOS
      );
    }
    try {
      run("/usr/bin/codesign", ["--verify", "--strict", artifactPath]);
    } catch {
      return "Mach-O code signature is invalid";
    }
    const teamIdentifier = readTeamIdentifier(artifactPath, run);
    const computerUse = manifest.capabilities.computerUse;
    const expectedTeamIdentifier =
      computerUse.status === "available" && artifact.path.startsWith(`${computerUse.appBundle}/`)
        ? computerUse.signingTeamId
        : manifest.peerAuthorization.signingTeamId;
    if (teamIdentifier !== expectedTeamIdentifier) {
      return "desktop tool runtime signing Team ID does not match the manifest";
    }
    return null;
  };
}
