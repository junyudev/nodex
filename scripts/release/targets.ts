import type { WindowsArchitecture } from "../desktop-build-target";
import type { BuildIdentity } from "./model";

export type MacArchitecture = "arm64";
export type WindowsReleaseArchitecture = `windows-${WindowsArchitecture}`;
export type ReleaseArchitecture = MacArchitecture | WindowsReleaseArchitecture;
export const RELEASE_ARCHITECTURES = ["arm64", "windows-x64", "windows-arm64"] as const;
export const WINDOWS_ARCHITECTURES = ["x64", "arm64"] as const;

export const windowsInstallerName = (version: string, architecture: WindowsArchitecture): string =>
  `Nodex-${version}-windows-${architecture}.exe`;

/** Both native distribution paths pass the same identity and update availability inputs. */
export const releaseBuildEnvironment = (
  identity: BuildIdentity,
  identityPath: string,
): NodeJS.ProcessEnv => ({
  ...process.env,
  NODEX_BUILD_VERSION: identity.buildVersion,
  NODEX_BUILD_IDENTITY_PATH: identityPath,
  NODEX_APP_UPDATES: "enabled",
  SENTRY_RELEASE: `nodex@${identity.version}+${identity.buildVersion}`,
});
