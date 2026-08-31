import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { readIsolatedRunLeaseOwner } from "../../../src/main/core-client/isolated-run-ownership";
import { installPrivateFile, resolveRegularPrivateFileSource } from "../../private-file";

import {
  ISOLATED_PROFILE_MANIFEST_FILE,
  type IsolatedProfileManifest,
  readIsolatedProfileManifest,
  writeIsolatedProfileManifest,
} from "./isolated-profile-manifest";

export type IsolatedCodexPolicy = "empty" | "copy-auth" | "copy-config" | "copy-auth-and-config";
export type IsolatedProfileRetention = "dispose" | "keep";

export interface IsolatedProfileOptions {
  readonly codex?: IsolatedCodexPolicy;
  readonly retention?: IsolatedProfileRetention;
  readonly label: string;
  readonly sourceCodexHome?: string;
}

export interface IsolatedProfile {
  readonly runId: string;
  readonly runRoot: string;
  readonly nodexHome: string;
  readonly settingsPath: string;
  readonly codexHome: string;
  readonly initialProjectsDirectory: string;
  readonly artifactsDirectory: string;
  readonly manifestPath: string;
  readonly repositoryRealpath: string;
  readonly retention: IsolatedProfileRetention;
}

export interface IsolatedProfileCleanupResult {
  readonly status: "deleted" | "kept" | "already_missing" | "unsafe";
  readonly reason?: string;
}

const ROOT_PREFIX = "ndx-scn-";
const execFileAsync = promisify(execFile);

const scenarioTempParent = (): string => (process.platform === "darwin" ? "/tmp" : os.tmpdir());

const sanitizedLabel = (label: string): string => {
  const value = label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 24);
  return value || "scenario";
};

const resolveSourceCodexHome = (explicit?: string): string => {
  if (explicit) return path.resolve(explicit);
  if (process.env.CODEX_HOME) return path.resolve(process.env.CODEX_HOME);
  return path.join(os.homedir(), ".codex");
};

const runtimeEvidencePaths = (nodexHome: string): readonly string[] => [
  path.join(nodexHome, "run/isolated-supervisor.lock"),
  path.join(nodexHome, "run/core/core.json"),
  path.join(nodexHome, "run/core/core.auth"),
  path.join(nodexHome, "run/core/core.sock"),
];

const existsOrSymlink = async (candidate: string): Promise<boolean> => {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const ensureOwnedRootShape = async (profile: IsolatedProfile): Promise<void> => {
  if (!path.isAbsolute(profile.runRoot)) {
    throw new Error("Isolated scenario Profile root must be absolute");
  }
  const stats = await lstat(profile.runRoot);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Isolated scenario Profile root must be a real directory");
  }
  const actualRoot = await realpath(profile.runRoot);
  if (actualRoot !== profile.runRoot) {
    throw new Error("Isolated scenario Profile root changed identity");
  }
  const tempRoot = await realpath(scenarioTempParent());
  if (path.dirname(actualRoot) !== tempRoot || !path.basename(actualRoot).startsWith(ROOT_PREFIX)) {
    throw new Error("Isolated scenario Profile root is outside the owned temp namespace");
  }
};

const descriptorFrom = (
  runRoot: string,
  manifest: IsolatedProfileManifest,
  retention: IsolatedProfileRetention,
): IsolatedProfile => ({
  runId: manifest.runId,
  runRoot,
  nodexHome: path.join(runRoot, ".nodex"),
  settingsPath: path.join(runRoot, ".nodex/config.toml"),
  codexHome: path.join(runRoot, ".nodex/agent"),
  initialProjectsDirectory: path.join(runRoot, "workspace"),
  artifactsDirectory: path.join(runRoot, "artifacts"),
  manifestPath: path.join(runRoot, ISOLATED_PROFILE_MANIFEST_FILE),
  repositoryRealpath: manifest.repositoryRealpath,
  retention,
});

export const createIsolatedProfile = async (
  options: IsolatedProfileOptions,
): Promise<IsolatedProfile> => {
  const repositoryRealpath = await realpath(process.cwd());
  const label = sanitizedLabel(options.label);
  const tempParent = await realpath(scenarioTempParent());
  const runRoot = await mkdtemp(path.join(tempParent, ROOT_PREFIX));
  const manifest: IsolatedProfileManifest = {
    version: 1,
    runId: randomUUID(),
    label,
    repositoryRealpath,
    createdAt: new Date().toISOString(),
  };
  const profile = descriptorFrom(runRoot, manifest, options.retention ?? "dispose");
  try {
    await writeIsolatedProfileManifest(profile.manifestPath, manifest);
    await Promise.all([
      mkdir(profile.nodexHome, { recursive: true, mode: 0o700 }),
      mkdir(profile.codexHome, { recursive: true, mode: 0o700 }),
      mkdir(profile.initialProjectsDirectory, { recursive: true, mode: 0o700 }),
      mkdir(profile.artifactsDirectory, { recursive: true, mode: 0o700 }),
    ]);

    const policy = options.codex ?? "empty";
    if (policy === "copy-config" || policy === "copy-auth-and-config") {
      const source = resolveSourceCodexHome(options.sourceCodexHome);
      const sourceConfig = path.join(source, "config.toml");
      if (await existsOrSymlink(sourceConfig)) {
        await execFileAsync(process.execPath, [
          "--import",
          "tsx",
          path.join(profile.repositoryRealpath, "scripts/copy-isolated-codex-config.ts"),
          sourceConfig,
          path.join(profile.codexHome, "config.toml"),
        ]);
        await chmod(path.join(profile.codexHome, "config.toml"), 0o600);
      }
    }
    if (policy === "copy-auth" || policy === "copy-auth-and-config") {
      const source = resolveSourceCodexHome(options.sourceCodexHome);
      const sourceAuth = await resolveRegularPrivateFileSource(
        path.join(source, "auth.json"),
        "Isolated Profile credential source",
      );
      await installPrivateFile(path.join(profile.codexHome, "auth.json"), (target) =>
        copyFile(sourceAuth, target),
      );
    }
    return profile;
  } catch (error) {
    const cleanup = await cleanupIsolatedProfile({
      ...profile,
      retention: "dispose",
    });
    if (cleanup.status === "unsafe") {
      // oxlint-disable-next-line eslint/preserve-caught-error -- AggregateError retains the primary failure and cleanup failure explicitly.
      throw new AggregateError(
        [error, new Error(cleanup.reason)],
        `Failed to create and clean isolated Profile ${profile.runRoot}`,
        { cause: error },
      );
    }
    throw error;
  }
};

export const resumeIsolatedProfile = async (runRoot: string): Promise<IsolatedProfile> => {
  if (!path.isAbsolute(runRoot)) {
    throw new Error("Retained scenario Profile root must be absolute");
  }
  const normalized = path.normalize(runRoot);
  const manifest = await readIsolatedProfileManifest(
    path.join(normalized, ISOLATED_PROFILE_MANIFEST_FILE),
  );
  const profile = descriptorFrom(normalized, manifest, "keep");
  await ensureOwnedRootShape(profile);
  if (manifest.repositoryRealpath !== (await realpath(process.cwd()))) {
    throw new Error("Retained scenario Profile belongs to another repository");
  }
  const leaseOwner = readIsolatedRunLeaseOwner(profile.nodexHome);
  if (leaseOwner) {
    throw new Error(
      `Retained scenario Profile has an active or stale lease owned by PID ${leaseOwner.supervisorPid}`,
    );
  }
  return profile;
};

export const cleanupIsolatedProfile = async (
  profile: IsolatedProfile,
): Promise<IsolatedProfileCleanupResult> => {
  if (profile.retention === "keep") return { status: "kept" };
  try {
    await ensureOwnedRootShape(profile);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { status: "already_missing" };
    }
    return {
      status: "unsafe",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let manifest: IsolatedProfileManifest;
  try {
    manifest = await readIsolatedProfileManifest(profile.manifestPath);
  } catch (error) {
    return {
      status: "unsafe",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (
    manifest.runId !== profile.runId ||
    manifest.repositoryRealpath !== profile.repositoryRealpath
  ) {
    return { status: "unsafe", reason: "Profile ownership manifest does not match" };
  }
  for (const evidencePath of runtimeEvidencePaths(profile.nodexHome)) {
    if (await existsOrSymlink(evidencePath)) {
      return {
        status: "unsafe",
        reason: "Core shutdown is not proven; runtime evidence remains",
      };
    }
  }
  await rm(profile.runRoot, { recursive: true });
  return { status: "deleted" };
};

export const withIsolatedProfile = async <Value>(
  options: IsolatedProfileOptions,
  run: (profile: IsolatedProfile) => Promise<Value>,
): Promise<Value> => {
  const profile = await createIsolatedProfile(options);
  let completed = false;
  let value: Value | undefined;
  let operationError: unknown;
  try {
    value = await run(profile);
    completed = true;
  } catch (error) {
    operationError = error;
  }
  const cleanup = await cleanupIsolatedProfile(profile);
  const cleanupError =
    cleanup.status === "unsafe"
      ? new Error(`Preserved unsafe scenario Profile ${profile.runRoot}: ${cleanup.reason}`)
      : null;
  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      `Isolated Profile work and cleanup both failed in ${profile.runRoot}`,
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  if (!completed) throw new Error("Isolated Profile work ended without a result");
  return value as Value;
};
