import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyPackagedBuildProvenance } from "./package-provenance.mjs";
import type { NativeRuntimeArchitecture } from "./native-runtime-manifest";
import { verifyPackagedNativeRuntimeStructure } from "./verify-native-runtime";
import { installCliCommand } from "../src/main/cli-command-installer";

export interface LocalMacInstallOptions {
  readonly allowProductionDestination: boolean;
  readonly cliTargetPath: string;
  readonly destination: string;
  readonly installCli: boolean;
  readonly source:
    | {
        readonly kind: "fresh";
        readonly repositoryRoot: string;
      }
    | {
        readonly appPath: string;
        readonly kind: "artifact";
      };
  /** Sign with the full release pipeline (Apple timestamps) instead of the fast local mode. */
  readonly strictSign: boolean;
  readonly targetArch: NativeRuntimeArchitecture;
}

export interface LocalMacBuildInstallOptions {
  readonly allowProductionDestination: boolean;
  readonly appPath: string;
  readonly cliTargetPath: string;
  readonly destination: string;
  readonly expectedPreparedManifestPath?: string;
  readonly installCli: boolean;
  readonly targetArch: NativeRuntimeArchitecture;
}

export interface FreshLocalMacPackagePlan {
  readonly appPath: string;
  readonly commands: readonly {
    readonly arguments: readonly string[];
    readonly command: string;
    readonly environment?: Readonly<Record<string, string>>;
  }[];
  readonly outputRoot: string;
  readonly preparedManifestPath: string;
}

const DEFAULT_DESTINATION = "/Applications/Nodex Dev.app";
const DEFAULT_CLI_TARGET = join(homedir(), ".local", "bin", "nodex");
const PRODUCTION_DESTINATION = "/Applications/Nodex.app";

const readRequiredValue = (
  arguments_: readonly string[],
  index: number,
  option: string,
): string => {
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
};

export function parseLocalMacInstallOptions(
  arguments_: readonly string[],
  architecture: string = process.arch,
  workingDirectory: string = process.cwd(),
): LocalMacInstallOptions {
  let appPath: string | null = null;
  let destination = DEFAULT_DESTINATION;
  let cliTargetPath = DEFAULT_CLI_TARGET;
  let targetArch: NativeRuntimeArchitecture | null = architecture === "arm64" ? "arm64" : null;
  let installCli = false;
  let allowProductionDestination = false;
  let strictSign = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--app-path") {
      appPath = readRequiredValue(arguments_, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--destination") {
      destination = readRequiredValue(arguments_, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--cli-target") {
      cliTargetPath = readRequiredValue(arguments_, index, argument);
      installCli = true;
      index += 1;
      continue;
    }
    if (argument === "--target-arch") {
      const value = readRequiredValue(arguments_, index, argument);
      if (value !== "arm64") {
        throw new Error("--target-arch must be arm64.");
      }
      targetArch = value;
      index += 1;
      continue;
    }
    if (argument === "--install-cli") {
      installCli = true;
      continue;
    }
    if (argument === "--allow-production-destination") {
      allowProductionDestination = true;
      continue;
    }
    if (argument === "--strict-sign") {
      strictSign = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument ?? "<missing>"}`);
  }

  if (!targetArch) {
    throw new Error("Could not infer the current Mac architecture; pass --target-arch.");
  }
  return {
    allowProductionDestination,
    cliTargetPath: resolve(cliTargetPath),
    destination: resolve(destination),
    installCli,
    source: appPath
      ? { appPath: resolve(appPath), kind: "artifact" }
      : { kind: "fresh", repositoryRoot: resolve(workingDirectory) },
    strictSign,
    targetArch,
  };
}

const assertAppBundle = (appPath: string, label: string): void => {
  if (!isAbsolute(appPath) || !appPath.endsWith(".app")) {
    throw new Error(`${label} must be an absolute .app path.`);
  }
  if (!existsSync(appPath)) {
    throw new Error(
      `${label} does not exist: ${appPath}\n` +
        "Run pnpm run package:mac first, or pass --app-path.",
    );
  }
  const metadata = lstatSync(appPath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a regular app bundle directory.`);
  }
};

export function assertLocalInstallDestination(options: LocalMacBuildInstallOptions): void {
  if (!isAbsolute(options.destination) || !options.destination.endsWith(".app")) {
    throw new Error("The local install destination must be an absolute .app path.");
  }
  if (options.destination === PRODUCTION_DESTINATION && !options.allowProductionDestination) {
    throw new Error(
      "Refusing to replace /Applications/Nodex.app without --allow-production-destination.",
    );
  }
  if (options.destination === "/" || dirname(options.destination) === "/") {
    throw new Error("Refusing a broad local install destination.");
  }
  if (options.destination === options.appPath) {
    throw new Error("The source and destination app paths must be different.");
  }
}

const assertNodexIsNotRunning = (): void => {
  const result = spawnSync("/usr/bin/pgrep", ["-x", "Nodex"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`Could not check for a running Nodex process: ${result.error.message}`);
  }
  if (result.status === 0) {
    throw new Error("Quit every running copy of Nodex before installing a local build.");
  }
  if (result.status !== 1) {
    throw new Error(`Could not check for a running Nodex process: ${result.stderr.trim()}`);
  }
};

const syncDirectory = (directory: string): void => {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const verify = (
  appPath: string,
  targetArch: NativeRuntimeArchitecture,
  expectedPreparedManifestPath?: string,
): string => {
  const provenance = verifyPackagedBuildProvenance(appPath, {
    expectedArch: targetArch,
    expectedPreparedManifestPath,
  });
  verifyPackagedNativeRuntimeStructure({
    appPath,
    expectedBuildVersion: provenance.product.version,
    expectedVersion: provenance.product.version,
    expectedUpdateChannel: "disabled",
    requireDeveloperId: false,
    targetArch,
    verifyNotarization: false,
    verifySignatures: false,
  });
  return provenance.provenanceId;
};

export async function installLocalMacBuild(options: LocalMacBuildInstallOptions): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Local Nodex app deployment is supported only on macOS.");
  }
  assertAppBundle(options.appPath, "The source app");
  assertLocalInstallDestination(options);
  assertNodexIsNotRunning();
  const sourceProvenanceId = verify(
    options.appPath,
    options.targetArch,
    options.expectedPreparedManifestPath,
  );

  const destinationParent = dirname(options.destination);
  mkdirSync(destinationParent, { recursive: true, mode: 0o755 });
  const parentMetadata = lstatSync(destinationParent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error("The destination parent must be a regular directory.");
  }
  if (existsSync(options.destination)) {
    assertAppBundle(options.destination, "The existing destination app");
  }

  const operationId = randomUUID();
  const stagingPath = join(
    destinationParent,
    `.${basename(options.destination, ".app")}-install-${operationId}.app`,
  );
  const rollbackPath = join(
    destinationParent,
    `.${basename(options.destination, ".app")}-rollback-${operationId}.app`,
  );
  const failedPath = join(
    destinationParent,
    `.${basename(options.destination, ".app")}-failed-${operationId}.app`,
  );
  let installed = false;
  let previousMoved = false;

  try {
    execFileSync("/usr/bin/ditto", [options.appPath, stagingPath], {
      stdio: "inherit",
    });
    const stagingProvenanceId = verify(
      stagingPath,
      options.targetArch,
      options.expectedPreparedManifestPath,
    );
    if (stagingProvenanceId !== sourceProvenanceId) {
      throw new Error("The staged app does not match the selected build generation.");
    }
    if (existsSync(options.destination)) {
      renameSync(options.destination, rollbackPath);
      previousMoved = true;
    }
    try {
      renameSync(stagingPath, options.destination);
      syncDirectory(destinationParent);
      const installedProvenanceId = verify(
        options.destination,
        options.targetArch,
        options.expectedPreparedManifestPath,
      );
      if (installedProvenanceId !== sourceProvenanceId) {
        throw new Error("The installed app does not match the selected build generation.");
      }
      installed = true;
    } catch (error) {
      if (existsSync(options.destination)) {
        renameSync(options.destination, failedPath);
      }
      if (previousMoved) {
        renameSync(rollbackPath, options.destination);
        previousMoved = false;
      }
      syncDirectory(destinationParent);
      if (existsSync(failedPath)) {
        rmSync(failedPath, { recursive: true, force: true });
      }
      throw error;
    }

    if (options.installCli) {
      const cliResult = installCliCommand({
        environmentPath: process.env.PATH,
        sourcePath: join(options.destination, "Contents/Resources/bin/nodex"),
        targetPath: options.cliTargetPath,
      });
      process.stdout.write(`CLI ${cliResult.status}: ${cliResult.targetPath}\n`);
      if (!cliResult.pathConfigured) {
        process.stdout.write(
          `Add ${dirname(cliResult.targetPath)} to PATH before invoking nodex by name.\n`,
        );
      }
    }
  } finally {
    if (existsSync(stagingPath)) {
      rmSync(stagingPath, { recursive: true, force: true });
    }
    if (installed && previousMoved && existsSync(rollbackPath)) {
      // macOS can briefly retain directory entries after the old bundle is removed.
      rmSync(rollbackPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      syncDirectory(destinationParent);
    }
  }

  process.stdout.write(`Installed local Nodex build: ${options.destination}\n`);
}

export function createFreshLocalMacPackagePlan(
  repositoryRoot: string,
  targetArch: NativeRuntimeArchitecture,
  operationId: string = randomUUID(),
  strictSign = false,
): FreshLocalMacPackagePlan {
  const root = resolve(repositoryRoot);
  const outputRoot = join(root, ".generated", "local-install", operationId);
  const architectureDirectory = "mac-arm64";
  return {
    appPath: join(outputRoot, architectureDirectory, "Nodex.app"),
    commands: [
      {
        command: "pnpm",
        arguments: ["run", "build"],
      },
      {
        command: "pnpm",
        arguments: ["run", `stage:native-runtime:mac:${targetArch}`],
      },
      {
        command: "pnpm",
        arguments: ["exec", "tsx", "scripts/prepared-electron-build.ts", "verify"],
      },
      {
        command: "pnpm",
        arguments: [
          "exec",
          "electron-builder",
          "--mac",
          "dir",
          `--${targetArch}`,
          "--publish",
          "never",
          "--config.mac.notarize=false",
          `--config.directories.output=${outputRoot}`,
        ],
        ...(strictSign ? {} : { environment: { NODEX_MAC_SIGN_MODE: "local" } }),
      },
      {
        command: "pnpm",
        arguments: ["exec", "tsx", "scripts/prepared-electron-build.ts", "verify"],
      },
    ],
    outputRoot,
    preparedManifestPath: join(root, ".generated", "prepared-electron-build.json"),
  };
}

const installFreshLocalMacBuild = async (options: LocalMacInstallOptions): Promise<void> => {
  if (options.source.kind !== "fresh") {
    throw new Error("Fresh local packaging requires a repository source.");
  }
  const plan = createFreshLocalMacPackagePlan(
    options.source.repositoryRoot,
    options.targetArch,
    randomUUID(),
    options.strictSign,
  );
  mkdirSync(dirname(plan.outputRoot), { recursive: true, mode: 0o700 });
  if (existsSync(plan.outputRoot)) {
    throw new Error(`Fresh local package output already exists: ${plan.outputRoot}`);
  }
  try {
    for (const command of plan.commands) {
      execFileSync(command.command, command.arguments, {
        cwd: options.source.repositoryRoot,
        env: command.environment ? { ...process.env, ...command.environment } : process.env,
        stdio: "inherit",
      });
    }
    await installLocalMacBuild({
      allowProductionDestination: options.allowProductionDestination,
      appPath: plan.appPath,
      cliTargetPath: options.cliTargetPath,
      destination: options.destination,
      expectedPreparedManifestPath: plan.preparedManifestPath,
      installCli: options.installCli,
      targetArch: options.targetArch,
    });
  } finally {
    if (existsSync(plan.outputRoot)) {
      rmSync(plan.outputRoot, { recursive: true, force: true });
    }
  }
};

export async function installLocalMac(options: LocalMacInstallOptions): Promise<void> {
  if (options.source.kind === "fresh") {
    await installFreshLocalMacBuild(options);
    return;
  }
  await installLocalMacBuild({
    allowProductionDestination: options.allowProductionDestination,
    appPath: options.source.appPath,
    cliTargetPath: options.cliTargetPath,
    destination: options.destination,
    installCli: options.installCli,
    targetArch: options.targetArch,
  });
}

const main = async (): Promise<void> => {
  const options = parseLocalMacInstallOptions(process.argv.slice(2));
  await installLocalMac(options);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
