import path from "node:path";

export interface MainCompileCacheInput {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly appName: string;
}

/**
 * Where a packaged Nodex keeps Node's compiled Main code: the account's own cache folder, which
 * no other account can write. Development builds change with every edit and their test launches
 * keep their own homes, so they compile from source.
 */
export function mainCompileCacheDirectory(input: MainCompileCacheInput): string | null {
  if (!input.isPackaged) return null;
  const { environment, home, appName } = input;
  switch (input.platform) {
    case "darwin":
      return path.join(home, "Library", "Caches", appName, "compile-cache");
    case "win32":
      return environment.LOCALAPPDATA
        ? path.win32.join(environment.LOCALAPPDATA, appName, "compile-cache")
        : null;
    default:
      return path.join(
        environment.XDG_CACHE_HOME?.trim() || path.join(home, ".cache"),
        appName,
        "compile-cache",
      );
  }
}
