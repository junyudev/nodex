export type DesktopArchitecture = "x64" | "arm64";
export type WindowsArchitecture = DesktopArchitecture;

export type DesktopBuildTarget =
  | {
      readonly platform: "darwin";
      readonly arch: "arm64";
      readonly key: "darwin-arm64";
      readonly rustTarget: "aarch64-apple-darwin";
      readonly executableSuffix: "";
      readonly runtime: "macos";
      readonly rustPackages: readonly string[];
    }
  | {
      readonly platform: "win32";
      readonly arch: WindowsArchitecture;
      readonly key: `win32-${WindowsArchitecture}`;
      readonly rustTarget: "x86_64-pc-windows-msvc" | "aarch64-pc-windows-msvc";
      readonly executableSuffix: ".exe";
      readonly runtime: "windows";
      readonly rustPackages: readonly string[];
    };

/** One target contract selects native binaries and optional platform runtimes. */
export function desktopBuildTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): DesktopBuildTarget {
  if (platform === "darwin" && arch === "arm64")
    return {
      platform,
      arch,
      key: "darwin-arm64",
      rustTarget: "aarch64-apple-darwin",
      executableSuffix: "",
      runtime: "macos",
      rustPackages: ["nodex-core-server", "nodex-cli", "nodex-browser-profile-helper"],
    };
  if (platform === "win32" && (arch === "x64" || arch === "arm64"))
    return {
      platform,
      arch,
      key: `win32-${arch}`,
      rustTarget: arch === "x64" ? "x86_64-pc-windows-msvc" : "aarch64-pc-windows-msvc",
      executableSuffix: ".exe",
      runtime: "windows",
      rustPackages: ["nodex-core-server", "nodex-cli"],
    };
  throw new Error(`Unsupported Nodex desktop target: ${platform}-${arch}`);
}

export const nativeExecutableName = (name: string, platform: string = process.platform): string =>
  `${name}${platform === "win32" ? ".exe" : ""}`;
