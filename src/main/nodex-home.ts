import path from "node:path";

export interface ResolveNodexHomePathOptions {
  cwd: string;
  platform?: string;
  env: NodeJS.ProcessEnv;
  userHome: string;
  configuredHome?: string;
}

function resolvePath(inputPath: string, cwd: string, platformPath: typeof path): string {
  return platformPath.isAbsolute(inputPath)
    ? platformPath.normalize(inputPath)
    : platformPath.resolve(cwd, inputPath);
}

function expandConfiguredHome(
  inputPath: string,
  userHome: string,
  platformPath: typeof path,
): string {
  if (inputPath === "~" || inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return platformPath.join(userHome, inputPath.slice(2));
  }
  return inputPath;
}

export function resolveNodexHomePath(options: ResolveNodexHomePathOptions): string {
  const platformPath = options.platform === "win32" ? path.win32 : path;
  const environmentHome = options.env.NODEX_HOME?.trim();
  if (environmentHome) {
    return resolvePath(environmentHome, options.cwd, platformPath);
  }

  const configuredHome = options.configuredHome?.trim();
  if (configuredHome) {
    return resolvePath(
      expandConfiguredHome(configuredHome, options.userHome, platformPath),
      options.cwd,
      platformPath,
    );
  }

  return platformPath.join(options.userHome, ".nodex");
}
