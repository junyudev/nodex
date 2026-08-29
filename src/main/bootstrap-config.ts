import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { resolveNodexHomePath } from "./nodex-home";

interface BootstrapServerTomlConfig {
  home?: string;
}

interface BootstrapRootTomlConfig extends Record<string, unknown> {
  server?: BootstrapServerTomlConfig;
}

export interface ResolveBootstrapNodexHomeOptions {
  isPackaged: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  exists?: (filePath: string) => boolean;
  readFile?: (filePath: string) => string;
}

function readServerSection(
  configPath: string,
  readFile: (filePath: string) => string,
): BootstrapServerTomlConfig | null {
  try {
    const parsed = parseToml(readFile(configPath)) as BootstrapRootTomlConfig;
    return parsed.server ?? null;
  } catch {
    return null;
  }
}

function findProjectConfig(cwd: string, exists: (filePath: string) => boolean): string | null {
  let dir = cwd;
  for (;;) {
    const candidate = path.join(dir, ".nodex", "config.toml");
    if (exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveBootstrapNodexHome(options: ResolveBootstrapNodexHomeOptions): string {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  if (!options.isPackaged && !env.NODEX_HOME?.trim()) {
    throw new Error(
      "Unpackaged Nodex requires NODEX_HOME. Start development with `vp run dev` or provide an isolated Profile explicitly.",
    );
  }
  const envHome = env.HOME?.trim();
  const homeDir = options.homeDir ?? (envHome ? envHome : homedir());
  const exists = options.exists ?? existsSync;
  const readFile = options.readFile ?? ((filePath) => readFileSync(filePath, "utf8"));

  const mergedConfig: BootstrapServerTomlConfig = {};
  const userConfig = path.join(homeDir, ".nodex", "config.toml");
  if (exists(userConfig)) {
    Object.assign(mergedConfig, readServerSection(userConfig, readFile) ?? {});
  }

  const projectConfig = findProjectConfig(cwd, exists);
  if (projectConfig) {
    Object.assign(mergedConfig, readServerSection(projectConfig, readFile) ?? {});
  }

  return resolveNodexHomePath({
    cwd,
    env,
    userHome: homeDir,
    configuredHome: mergedConfig.home,
  });
}
