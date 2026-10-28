/* @effect-diagnostics asyncFunction:off -- Private atomic filesystem publication is a Node Adapter. */
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
    (stats.mode & 0o777) !== 0o700 ||
    (process.getuid && stats.uid !== process.getuid())
  ) {
    throw new Error("Fatal incident directory must be private and owned");
  }
};

const writeIncident = async (nodexHome: string, incident: MainFatalIncident): Promise<string> => {
  if (!path.isAbsolute(nodexHome) || !UUID.test(incident.id)) {
    throw new Error("Invalid fatal incident identity");
  }
  const timestamp = incident.occurredAt.replace(/\D/gu, "");
  if (timestamp.length !== 17 || !Number.isFinite(Date.parse(incident.occurredAt))) {
    throw new Error("Invalid fatal incident time");
  }
  const bytes = Buffer.from(`${JSON.stringify(incident)}\n`, "utf8");
  if (bytes.byteLength > MAX_FATAL_INCIDENT_BYTES) throw new Error("Fatal incident exceeds budget");

  await requirePrivateDirectory(nodexHome);
  const diagnostics = path.join(nodexHome, "diagnostics");
  await requirePrivateDirectory(diagnostics);
  const directory = path.join(diagnostics, "fatal");
  await requirePrivateDirectory(directory);
  // The Profile's single Main process publishes one final exit. Recover unpublished
  // files left by a previous process so interrupted publication cannot grow retention.
  for (const name of (await readdir(directory)).filter((name) => TEMPORARY_NAME.test(name))) {
    await rm(path.join(directory, name), { force: true });
  }
  const publishedName = `${timestamp}-${incident.id}.json`;
  const destination = path.join(directory, publishedName);
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
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
    const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return destination;
  } finally {
    await file.close();
    await rm(temporary, { force: true });
  }
};

export const layerForHome = (nodexHome: string): Layer.Layer<MainFatalIncidentStore> =>
  Layer.succeed(
    MainFatalIncidentStore,
    MainFatalIncidentStore.of({
      write: (incident) =>
        Effect.tryPromise({
          try: () => writeIncident(nodexHome, incident),
          catch: (cause) => new MainFatalIncidentStoreError({ cause }),
        }),
    }),
  );

export const live: Layer.Layer<MainFatalIncidentStore, never, MainConfig> = Layer.unwrap(
  Effect.map(MainConfig, (config) => layerForHome(config.nodexHome)),
);
