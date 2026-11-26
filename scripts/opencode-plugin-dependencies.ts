import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { openCodeAgent } from "../src/shared/agents/opencode";
import {
  ensureImmutableDirectory,
  resolveImmutableDirectoryPath,
} from "./immutable-artifact-cache";

const pluginName = "@opencode-ai/plugin";
const recipeVersion = 1;
const execFileAsync = promisify(execFile);
const versionsByExecutable = new Map<string, Promise<string | undefined>>();

interface SeedOpenCodePluginDependenciesInput {
  readonly nodexHome: string;
  readonly projectRoot: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cachePath?: string;
  readonly install?: (directory: string, environment: NodeJS.ProcessEnv) => Promise<void>;
}

function resolveOpenCodeExecutable(
  environment: NodeJS.ProcessEnv,
  cwd: string,
): string | undefined {
  const command = openCodeAgent.profile.executable.defaultValue;
  const candidates = (environment.PATH?.split(path.delimiter) ?? []).map((directory) =>
    path.resolve(cwd, directory, command),
  );
  candidates.push(path.resolve(environment.HOME || homedir(), ".opencode", "bin", command));

  return candidates.find((candidate) => {
    try {
      if (!statSync(candidate).isFile()) return false;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

async function probeVersion(
  executable: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(executable, ["--version"], {
      env,
      cwd,
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    const version = stdout.trim();
    const match = /^1\.(\d+)\.(\d+)(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/iu.exec(version);
    // From 1.15.13, the oldest OpenCode Nodex supports, npm Arborist installs the plugin SDK
    // and replaces a linked node_modules instead of writing through it. Early 1.x releases
    // install with `bun add`, and 2.x installs nothing into its settings: neither is seeded.
    const [minor, patch] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
    return minor > 15 || (minor === 15 && patch >= 13) ? version : undefined;
  } catch (error) {
    warnSeedFailure(error);
    return undefined;
  }
}

function openCodeVersion(
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string | undefined> {
  const { dev, ino, size, mtimeNs, ctimeNs } = statSync(executable, { bigint: true });
  const identity = `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}`;
  const cached = versionsByExecutable.get(identity);
  if (cached) return cached;

  const probe = probeVersion(executable, environment, cwd);
  versionsByExecutable.set(identity, probe);
  return probe;
}

async function installWithNpm(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  await execFileAsync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock", "--global=false"],
    { cwd, env, timeout: 60_000, killSignal: "SIGKILL" },
  );
}

function validateInstall(directory: string, version: string): void {
  const lock = JSON.parse(readFileSync(path.join(directory, "package-lock.json"), "utf8")) as {
    readonly packages?: Record<string, { readonly dependencies?: Record<string, unknown> }>;
  };
  // OpenCode 1.x checks whether the root lockfile dependencies contain the plugin name.
  if (!Object.hasOwn(lock.packages?.[""]?.dependencies ?? {}, pluginName)) {
    throw new Error(`The npm lockfile is missing ${pluginName}`);
  }
  const installed = JSON.parse(
    readFileSync(path.join(directory, "node_modules", pluginName, "package.json"), "utf8"),
  ) as { readonly version?: unknown };
  if (installed.version !== version) {
    throw new Error(`Expected ${pluginName}@${version} in the shared install`);
  }
}

const seedEntries = ["package.json", "package-lock.json", "node_modules"];

function canSeedConfig(nodexHome: string, segments: readonly string[]): boolean {
  if (!lstatSync(nodexHome, { throwIfNoEntry: false })?.isDirectory()) return false;

  let directory = nodexHome;
  for (const segment of segments) {
    directory = path.join(directory, segment);
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (!entry) return true;
    if (!entry.isDirectory()) return false;
  }
  return seedEntries.every(
    (name) => !lstatSync(path.join(directory, name), { throwIfNoEntry: false }),
  );
}

function seedConfig(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const copied: string[] = [];
  try {
    for (const name of ["package.json", "package-lock.json"]) {
      const target = path.join(destination, name);
      copyFileSync(path.join(source, name), target, constants.COPYFILE_EXCL);
      copied.push(target);
    }
    symlinkSync(path.join(source, "node_modules"), path.join(destination, "node_modules"), "dir");
  } catch (error) {
    for (const target of copied) rmSync(target, { force: true });
    throw error;
  }
}

function warnSeedFailure(error: unknown): void {
  const reason = (error instanceof Error ? error.message : String(error)).split(/\r?\n/u, 1)[0];
  console.warn(`Could not seed shared OpenCode plugin dependencies: ${reason}`);
}

/** Seeds the default OpenCode instance of a newly created development home. */
export async function seedOpenCodePluginDependencies(
  input: SeedOpenCodePluginDependenciesInput,
): Promise<void> {
  if (process.platform === "win32") return;

  const { driver, profile } = openCodeAgent;
  const segments = ["agents", driver, profile.initialId, "config", driver];
  const configDirectory = path.join(input.nodexHome, ...segments);
  try {
    if (!canSeedConfig(input.nodexHome, segments)) return;
    const cwd = input.projectRoot;
    const executable = resolveOpenCodeExecutable(input.environment, cwd);
    if (!executable) return;
    const version = await openCodeVersion(executable, input.environment, cwd);
    if (!version) return;

    const manifest = `${JSON.stringify({ dependencies: { [pluginName]: version } })}\n`;
    const archiveSha256 = createHash("sha256")
      .update(JSON.stringify({ recipeVersion, manifest }))
      .digest("hex");
    const destinationPath = resolveImmutableDirectoryPath({
      archiveSha256,
      cachePath: input.cachePath,
      directoryName: `plugin-${version}-v${recipeVersion}`,
      family: "opencode-plugin-dependencies",
      projectRoot: input.projectRoot,
    });
    await ensureImmutableDirectory(
      {
        destinationPath,
        label: `shared OpenCode ${version} plugin dependencies`,
        generate: async (directory) => {
          mkdirSync(directory);
          writeFileSync(path.join(directory, "package.json"), manifest);
          await (input.install ?? installWithNpm)(directory, input.environment);
        },
        validate: (directory) => validateInstall(directory, version),
      },
      (directory) => {
        if (canSeedConfig(input.nodexHome, segments)) seedConfig(directory, configDirectory);
      },
    );
  } catch (error) {
    warnSeedFailure(error);
  }
}
