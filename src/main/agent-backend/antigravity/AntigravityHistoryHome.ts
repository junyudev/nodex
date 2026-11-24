import { posix, win32 } from "node:path";
import { hostEnvironmentValue } from "../../platform/node/HostExecutableSearch";

/**
 * The Gemini root where Antigravity's desktop app and its command line keep their conversations,
 * shared by every profile. Matches agy's home expansion.
 */
export function antigravityHistoryHome(input: {
  readonly platform: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}): string {
  const { platform, environment, homeDirectory } = input;
  if (platform === "win32") {
    const profile = hostEnvironmentValue(environment, "USERPROFILE", platform);
    const drive = hostEnvironmentValue(environment, "HOMEDRIVE", platform);
    const path = hostEnvironmentValue(environment, "HOMEPATH", platform);
    const home = profile || (drive && path ? drive + path : homeDirectory);
    return win32.join(home, ".gemini");
  }
  return posix.join(environment.HOME || homeDirectory, ".gemini");
}
