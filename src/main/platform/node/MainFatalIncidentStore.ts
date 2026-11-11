/* @effect-diagnostics asyncFunction:off -- Private atomic filesystem publication is a Node Adapter. */
import { syncDirectory } from "../../durable-json-file";
import { resolveCoreExecutable } from "../../core-client/core-launcher";
import { makePrivatePaths } from "./private-filesystem";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { MainConfig } from "../../app/MainConfig";
import type { MainFatalIncident } from "../../app/MainFatalIncident";

export const MAX_FATAL_INCIDENT_BYTES = 16 * 1024;
export const MAX_FATAL_INCIDENT_FILES = 8;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const RECORD_NAME = /^\d{17}-[a-f0-9-]{36}\.json$/u;
const TEMPORARY_NAME = /^[a-f0-9-]{36}\.tmp$/u;

export class MainFatalIncidentStoreError extends Schema.TaggedError<MainFatalIncidentStoreError>()(
  "MainFatalIncidentStoreError",
  { cause: Schema.Defect() },
) {}

export class MainFatalIncidentStore extends Context.Service<
  MainFatalIncidentStore,
  {
    readonly write: (
      incident: MainFatalIncident,
    ) => Effect.Effect<string, MainFatalIncidentStoreError>;
  }
>()("nodex/main/platform/MainFatalIncidentStore") {}

const requirePrivateDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
  const stats = await lstat(directory);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (process.platform !== "win32" && (stats.mode & 0o777) !== 0o700) ||
    (process.getuid && stats.uid !== process.getuid())
  ) {
    throw new Error("Fatal incident directory must be private and owned");
  }
};

class PrivateIncidentPermissionsError extends Error {}

/** This fallback is public-safe even when Windows cannot establish a private DACL.
 * Reconstruct a closed record; never downgrade the full incident's permissions.
 */
const startupFailureRecord = (incident: MainFatalIncident) => {
  const core = incident.causes.find((cause) => cause.executable === "nodex-core.exe");
  const exitCode = core?.exitCode;
  return {
    version: 1,
    id: incident.id,
    occurredAt: incident.occurredAt,
    appVersion: incident.appVersion,
    reason: core ? "core-startup-failed" : "desktop-startup-failed",
    ...(core ? { executable: "nodex-core.exe" } : {}),
    ...(typeof exitCode === "number" && Number.isInteger(exitCode)
      ? {
          exitCode,
          windowsStatus: `0x${(exitCode >>> 0).toString(16).padStart(8, "0").toUpperCase()}`,
        }
      : {}),
    ...(core?.spawnCode && /^E[A-Z0-9_]{1,30}$/u.test(core.spawnCode)
      ? { spawnCode: core.spawnCode }
      : {}),
  };
};

const writeIncident = async (
  nodexHome: string,
  coreExecutable: string,
  incident: MainFatalIncident,
  publication: "private" | "startup" = "private",
): Promise<string> => {
  if (!path.isAbsolute(nodexHome) || !UUID.test(incident.id)) {
    throw new Error("Invalid fatal incident identity");
  }
  const timestamp = incident.occurredAt.replace(/\D/gu, "");
  if (timestamp.length !== 17 || !Number.isFinite(Date.parse(incident.occurredAt))) {
    throw new Error("Invalid fatal incident time");
  }
  const bytes = Buffer.from(
    `${JSON.stringify(publication === "startup" ? startupFailureRecord(incident) : incident)}\n`,
    "utf8",
  );
  if (bytes.byteLength > MAX_FATAL_INCIDENT_BYTES) throw new Error("Fatal incident exceeds budget");

  await requirePrivateDirectory(nodexHome);
  const diagnostics = path.join(nodexHome, "diagnostics");
  await requirePrivateDirectory(diagnostics);
  const directory = path.join(diagnostics, publication === "startup" ? "startup" : "fatal");
  await requirePrivateDirectory(directory);
  // The Profile's single Main process publishes one final exit. Recover unpublished
  // files left by a previous process so interrupted publication cannot grow retention.
  const publishedName = `${timestamp}-${incident.id}.json`;
  const destination = path.join(directory, publishedName);
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    // Secure the empty file and its parents in one native call, before writing private bytes.
    if (process.platform === "win32" && publication === "private") {
      try {
        await makePrivatePaths(
          [
            { path: nodexHome, directory: true },
            { path: diagnostics, directory: true },
            { path: directory, directory: true },
            { path: temporary, directory: false },
          ],
          coreExecutable,
        );
      } catch (cause) {
        throw new PrivateIncidentPermissionsError("Native private filesystem is unavailable", {
          cause,
        });
      }
    }
    for (const name of (await readdir(directory)).filter(
      (name) => TEMPORARY_NAME.test(name) && name !== path.basename(temporary),
    )) {
      await rm(path.join(directory, name), { force: true });
    }
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    await rename(temporary, destination);
    const records = (await readdir(directory))
      .filter((name) => RECORD_NAME.test(name) && name !== publishedName)
      .sort();
    // Always keep this incident, including after an operating-system clock rollback.
    for (const name of records.slice(
      0,
      Math.max(0, records.length - MAX_FATAL_INCIDENT_FILES + 1),
    )) {
      await rm(path.join(directory, name), { force: true });
    }
    await syncDirectory(directory);
    return destination;
  } finally {
    await file.close();
    await rm(temporary, { force: true });
  }
};

export const layerForHome = (
  nodexHome: string,
  coreExecutable: string,
): Layer.Layer<MainFatalIncidentStore> =>
  Layer.succeed(
    MainFatalIncidentStore,
    MainFatalIncidentStore.of({
      write: (incident) =>
        Effect.tryPromise({
          try: async () => {
            try {
              return await writeIncident(nodexHome, coreExecutable, incident);
            } catch (error) {
              if (
                process.platform !== "win32" ||
                incident.phase !== "startup" ||
                !(error instanceof PrivateIncidentPermissionsError)
              )
                throw error;
              return writeIncident(nodexHome, coreExecutable, incident, "startup");
            }
          },
          catch: (cause) => new MainFatalIncidentStoreError({ cause }),
        }),
    }),
  );

export const live: Layer.Layer<MainFatalIncidentStore, never, MainConfig> = Layer.unwrap(
  Effect.map(MainConfig, (config) =>
    layerForHome(
      config.nodexHome,
      resolveCoreExecutable({
        environment: config.environment,
        isPackaged: config.isPackaged,
        appResourcesPath: config.resourcesPath,
        repositoryRoot: config.projectRootPath,
      }),
    ),
  ),
);
