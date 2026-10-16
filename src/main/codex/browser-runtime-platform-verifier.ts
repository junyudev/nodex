import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { readRuntimeInspectionCommand } from "../platform/node/RuntimeArtifactVerification";
import { BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION } from "../../shared/browser-runtime-metadata";
import { parseMachOMinimumMacosVersion } from "../../shared/mach-o-minimum-macos";
import type { BrowserRuntimePlatformArtifactVerifier } from "./browser-runtime-bundle";

type CommandReader = (command: string, args: string[], signal?: AbortSignal) => Promise<string>;

const PRODUCT_MINIMUM_MACOS = BROWSER_RUNTIME_PRODUCT_MINIMUM_MACOS_VERSION;

function declaredArtifactMinimumMacos(
  artifactPath: string,
  manifest: Parameters<BrowserRuntimePlatformArtifactVerifier>[0]["manifest"],
): string | null {
  const nativePip = manifest.capabilities.nativePip;
  if (nativePip && artifactPath === nativePip.addon) {
    return nativePip.artifactMinimumMacOSVersion;
  }
  const computerUse = manifest.capabilities.computerUse;
  if (computerUse.status === "available" && artifactPath === computerUse.serviceExecutable) {
    return computerUse.artifactMinimumMacOSVersion;
  }
  const chrome = manifest.capabilities.browserUse?.backends.chrome;
  return chrome?.status === "available" && artifactPath === chrome.nativeHost.path
    ? chrome.nativeHost.artifactMinimumMacOSVersion
    : null;
}

const parseVersion = (value: string): readonly number[] | null =>
  /^\d+(?:\.\d+){0,2}$/u.test(value) ? value.split(".").map(Number) : null;

export { parseMachOMinimumMacosVersion } from "../../shared/mach-o-minimum-macos";

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

async function isMachO(filePath: string): Promise<boolean> {
  const descriptor = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(4);
    if ((await descriptor.read(header, 0, header.length, 0)).bytesRead !== header.length)
      return false;
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
    await descriptor.close();
  }
}

async function readTeamIdentifier(
  filePath: string,
  run: CommandReader,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const output = await run("/usr/bin/codesign", ["-dv", "--verbose=4", filePath], signal);
    return /^TeamIdentifier=(.+)$/mu.exec(output)?.[1]?.trim() ?? null;
  } catch {
    signal?.throwIfAborted();
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
  const run = options.runCommand ?? readRuntimeInspectionCommand;
  return async ({ artifact, artifactPath, manifest, signal }) => {
    signal?.throwIfAborted();
    if (platform !== manifest.targetPlatform) {
      return `runtime target ${manifest.targetPlatform} cannot be verified on ${platform}`;
    }
    if (platform !== "darwin") {
      return `Browser runtime platform verification is unavailable on ${platform}`;
    }
    if (manifest.targetArch !== "arm64") {
      return "Browser runtime requires macOS arm64";
    }
    if (!(await isMachO(artifactPath))) {
      return artifact.architecture === "any"
        ? null
        : "architecture-specific artifact is not Mach-O";
    }

    let architectures: string[];
    try {
      architectures = (await run("/usr/bin/lipo", ["-archs", artifactPath], signal))
        .split(/\s+/u)
        .filter(Boolean);
    } catch {
      signal?.throwIfAborted();
      return "could not inspect Mach-O architecture";
    }
    const expectedArch = manifest.targetArch;
    if (!architectures.includes(expectedArch)) {
      return `Mach-O artifact does not contain ${expectedArch}`;
    }
    let minimumMacos: string | null;
    try {
      minimumMacos = parseMachOMinimumMacosVersion(
        await run("/usr/bin/otool", ["-arch", expectedArch, "-l", artifactPath], signal),
      );
    } catch {
      signal?.throwIfAborted();
      minimumMacos = null;
    }
    if (!minimumMacos) return "could not inspect Mach-O minimum macOS version";
    const declaredMinimumMacos = declaredArtifactMinimumMacos(artifact.path, manifest);
    if (declaredMinimumMacos && compareVersions(minimumMacos, declaredMinimumMacos) !== 0) {
      return (
        `Mach-O artifact minimum macOS ${minimumMacos} does not match manifest declaration ` +
        declaredMinimumMacos
      );
    }
    if (compareVersions(minimumMacos, PRODUCT_MINIMUM_MACOS) === 1) {
      return (
        `Mach-O artifact requires macOS ${minimumMacos}, newer than the product minimum ` +
        PRODUCT_MINIMUM_MACOS
      );
    }
    try {
      await run("/usr/bin/codesign", ["--verify", "--strict", artifactPath], signal);
    } catch {
      signal?.throwIfAborted();
      return "Mach-O code signature is invalid";
    }
    const teamIdentifier = await readTeamIdentifier(artifactPath, run, signal);
    const computerUse = manifest.capabilities.computerUse;
    const chrome = manifest.capabilities.browserUse?.backends.chrome;
    const expectedTeamIdentifier =
      chrome?.status === "available" && artifact.path === chrome.nativeHost.path
        ? chrome.nativeHost.signingTeamId
        : computerUse.status === "available" &&
            artifact.path.startsWith(`${computerUse.appBundle}/`)
          ? computerUse.signingTeamId
          : manifest.peerAuthorization.signingTeamId;
    if (teamIdentifier !== expectedTeamIdentifier) {
      return "desktop tool runtime signing Team ID does not match the manifest";
    }
    return null;
  };
}
