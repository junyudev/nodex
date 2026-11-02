import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export type CliCommandInstallStatus = "already-installed" | "installed" | "updated";

export interface CliCommandInstallResult {
  readonly pathConfigured: boolean;
  readonly sourcePath: string;
  readonly status: CliCommandInstallStatus;
  readonly targetPath: string;
}

export interface InstallCliCommandOptions {
  readonly environmentPath?: string;
  readonly sourcePath: string;
  readonly targetPath: string;
}

const assertAbsolutePath = (candidate: string, label: string): string => {
  if (!isAbsolute(candidate)) {
    throw new Error(`${label} must be absolute.`);
  }
  return resolve(candidate);
};

const assertRegularExecutable = (candidate: string): void => {
  const metadata = lstatSync(candidate);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`The packaged Nodex CLI is not a regular file: ${candidate}`);
  }
  accessSync(candidate, constants.X_OK);
};

const isManagedNodexCliSource = (candidate: string): boolean => {
  const binDirectory = dirname(candidate);
  const resourcesDirectory = dirname(binDirectory);
  const contentsDirectory = dirname(resourcesDirectory);
  const appDirectory = dirname(contentsDirectory);
  return (
    candidate === join(binDirectory, "nodex") &&
    binDirectory === join(appDirectory, "Contents", "Resources", "bin") &&
    resourcesDirectory === join(appDirectory, "Contents", "Resources") &&
    contentsDirectory === join(appDirectory, "Contents") &&
    basename(appDirectory).startsWith("Nodex") &&
    basename(appDirectory).endsWith(".app")
  );
};

const resolveSymlinkTarget = (linkPath: string): string => {
  const target = readlinkSync(linkPath);
  return resolve(dirname(linkPath), target);
};

const isDirectoryOnPath = (directory: string, environmentPath: string | undefined): boolean => {
  if (!environmentPath) return false;
  return environmentPath
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .some((entry) => resolve(entry) === directory);
};

export function installCliCommand(options: InstallCliCommandOptions): CliCommandInstallResult {
  const sourcePath = assertAbsolutePath(options.sourcePath, "CLI source path");
  const targetPath = assertAbsolutePath(options.targetPath, "CLI target path");
  const targetDirectory = dirname(targetPath);
  assertRegularExecutable(sourcePath);
  mkdirSync(targetDirectory, { recursive: true, mode: 0o755 });
  const targetDirectoryMetadata = lstatSync(targetDirectory);
  if (targetDirectoryMetadata.isSymbolicLink() || !targetDirectoryMetadata.isDirectory()) {
    throw new Error(`The CLI install directory is not a regular directory: ${targetDirectory}`);
  }

  let existingSource: string | null = null;
  try {
    const targetMetadata = lstatSync(targetPath);
    if (!targetMetadata.isSymbolicLink()) {
      throw new Error(`Refusing to replace an existing non-symlink: ${targetPath}`);
    }
    existingSource = resolveSymlinkTarget(targetPath);
    if (existingSource === sourcePath) {
      return {
        pathConfigured: isDirectoryOnPath(targetDirectory, options.environmentPath),
        sourcePath,
        status: "already-installed",
        targetPath,
      };
    }
    if (!isManagedNodexCliSource(existingSource)) {
      throw new Error(`Refusing to replace a symlink not managed by Nodex: ${targetPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (!existingSource) {
    symlinkSync(sourcePath, targetPath);
    return {
      pathConfigured: isDirectoryOnPath(targetDirectory, options.environmentPath),
      sourcePath,
      status: "installed",
      targetPath,
    };
  }

  const operationId = `${process.pid}-${randomUUID()}`;
  const stagedLink = join(targetDirectory, `.nodex-link-${operationId}`);
  const rollbackLink = join(targetDirectory, `.nodex-link-rollback-${operationId}`);
  symlinkSync(sourcePath, stagedLink);
  try {
    if (resolveSymlinkTarget(targetPath) !== existingSource) {
      throw new Error(`The existing Nodex CLI symlink changed during installation: ${targetPath}`);
    }
    renameSync(targetPath, rollbackLink);
    try {
      renameSync(stagedLink, targetPath);
    } catch (error) {
      renameSync(rollbackLink, targetPath);
      throw error;
    }
    rmSync(rollbackLink, { force: true });
  } finally {
    rmSync(stagedLink, { force: true });
  }

  return {
    pathConfigured: isDirectoryOnPath(targetDirectory, options.environmentPath),
    sourcePath,
    status: "updated",
    targetPath,
  };
}
