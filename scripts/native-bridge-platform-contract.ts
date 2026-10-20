import { execFileSync } from "node:child_process";
import {
  compareMacosVersions,
  parseOtoolMinimumMacosVersion,
} from "./agent-runtime-macos-platform-contract";
import {
  NATIVE_RUNTIME_MINIMUM_MACOS,
  type NativeRuntimeArchitecture,
} from "./native-runtime-manifest";

/** Nodex-owned bridges use the exact product target; vendor binaries may target older systems. */
export function verifyOwnedNativeBridgePlatform(
  binaryPath: string,
  architecture: NativeRuntimeArchitecture,
): void {
  const actualArchitecture = execFileSync("/usr/bin/lipo", ["-archs", binaryPath], {
    encoding: "utf8",
  }).trim();
  if (actualArchitecture !== architecture) {
    throw new Error(`Native bridge architecture mismatch for ${binaryPath}: ${actualArchitecture}`);
  }
  const minimumMacOS = parseOtoolMinimumMacosVersion(
    execFileSync("/usr/bin/otool", ["-l", binaryPath], { encoding: "utf8" }),
  );
  if (compareMacosVersions(minimumMacOS, NATIVE_RUNTIME_MINIMUM_MACOS) !== 0) {
    throw new Error(
      `Native bridge minimum macOS mismatch for ${binaryPath}: ` +
        `expected ${NATIVE_RUNTIME_MINIMUM_MACOS}, found ${minimumMacOS}`,
    );
  }
}
