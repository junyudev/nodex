import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { resolveNodexHomePath } from "./nodex-home";
import {
  readSettingsTomlDocument,
  SETTINGS_DOCUMENT_MAX_BYTES,
  type SettingsTomlDocument,
} from "./settings/settings-document";

interface BootstrapServerTomlConfig {
  home?: string;
}

interface BootstrapRootTomlConfig extends Record<string, unknown> {
  server?: BootstrapServerTomlConfig;
}

export interface BootstrapConfigSnapshot {
  readonly environment: Readonly<Record<string, string>>;
  readonly nodexHome: string;
  readonly profileSettingsPath: string;
  readonly projectBootstrapConfigPath: string | null;
  readonly userBootstrapConfigPath: string;
}

export interface ResolveBootstrapConfigOptions {
  readonly isPackaged: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly exists?: (filePath: string) => boolean;
  readonly readDocument?: (filePath: string) => SettingsTomlDocument;
  /** Test-only text reader retained at this pure filesystem boundary. */
  readonly readFile?: (filePath: string) => string;
}

function readBootstrapServerSection(
  configPath: string,
  readDocument: (filePath: string) => SettingsTomlDocument,
): BootstrapServerTomlConfig {
  const parsed = readDocument(configPath) as BootstrapRootTomlConfig;
  const server = parsed.server;
  if (server === undefined) return {};
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    throw new Error(`Bootstrap [server] must be a TOML table: ${configPath}`);
  }
  if (server.home !== undefined && typeof server.home !== "string") {
    throw new Error(`Bootstrap server.home must be a string: ${configPath}`);
  }
  return server;
}

function findProjectConfig(cwd: string, exists: (filePath: string) => boolean): string | null {
  let directory = cwd;
  for (;;) {
    const candidate = path.join(directory, ".nodex", "config.toml");
    if (exists(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  );
}

function testDocumentReader(readFile: (filePath: string) => string) {
  return (filePath: string): SettingsTomlDocument => {
    const source = readFile(filePath);
    if (Buffer.byteLength(source, "utf8") > SETTINGS_DOCUMENT_MAX_BYTES) {
      throw new Error(
        `Settings document exceeds ${SETTINGS_DOCUMENT_MAX_BYTES} bytes: ${filePath}`,
      );
    }
    const parsed = parseToml(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Settings document must contain a TOML table: ${filePath}`);
    }
    return parsed as SettingsTomlDocument;
  };
}

/** The only process-ambient discovery seam. Runtime settings use the returned absolute path. */
export function resolveBootstrapConfig(
  options: ResolveBootstrapConfigOptions,
): BootstrapConfigSnapshot {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const environment = stringEnvironment(options.env ?? process.env);
  if (!options.isPackaged && !environment.NODEX_HOME?.trim()) {
    throw new Error(
      "Unpackaged Nodex requires NODEX_HOME. Start development with `vp run dev` or provide an isolated Profile explicitly.",
    );
  }

  const homeDir = path.resolve(
    options.homeDir ?? (environment.HOME?.trim() ? environment.HOME : homedir()),
  );
  const exists = options.exists ?? existsSync;
  const readDocument =
    options.readDocument ??
    (options.readFile ? testDocumentReader(options.readFile) : readSettingsTomlDocument);
  const userBootstrapConfigPath = path.join(homeDir, ".nodex", "config.toml");
  const projectBootstrapConfigPath = findProjectConfig(cwd, exists);

  const mergedConfig: BootstrapServerTomlConfig = {};
  if (exists(userBootstrapConfigPath)) {
    Object.assign(mergedConfig, readBootstrapServerSection(userBootstrapConfigPath, readDocument));
  }
  if (projectBootstrapConfigPath) {
    Object.assign(
      mergedConfig,
      readBootstrapServerSection(projectBootstrapConfigPath, readDocument),
    );
  }

  const nodexHome = resolveNodexHomePath({
    cwd,
    env: environment,
    userHome: homeDir,
    configuredHome: mergedConfig.home,
  });
  const runtimeEnvironment = Object.freeze({ ...environment, NODEX_HOME: nodexHome });
  return Object.freeze({
    environment: runtimeEnvironment,
    nodexHome,
    profileSettingsPath: path.join(nodexHome, "config.toml"),
    projectBootstrapConfigPath,
    userBootstrapConfigPath,
  });
}
