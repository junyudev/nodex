/* @effect-diagnostics preferSchemaOverJson:off -- Verifies the persisted incident JSON through the filesystem Adapter. */
import { mkdtemp, readFile, readdir, rm, stat, symlink, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { assert, it } from "@effect/vitest";
import { MainApplicationError } from "../../app/MainExit";
import { makeMainFatalIncident } from "../../app/MainFatalIncident";
import {
  MainFatalIncidentStore,
  layerForHome,
  MAX_FATAL_INCIDENT_FILES,
  MAX_FATAL_INCIDENT_BYTES,
} from "./MainFatalIncidentStore";

const profile = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-fatal-record-"))),
  (home) => Effect.promise(() => rm(home, { recursive: true, force: true })),
);
const incident = (index = 0) =>
  makeMainFatalIncident(
    {
      _tag: "Failure",
      phase: "runtime",
      cause: Cause.fail(
        new MainApplicationError({
          phase: "runtime",
          operation: "core",
          cause: new Error("private content"),
        }),
      ),
    },
    { failures: [] },
    {
      id: randomUUID(),
      occurredAt: `2026-10-28T00:00:${String(index).padStart(2, "0")}.000Z`,
      appVersion: "0.4.0",
    },
  );

it.live("publishes private restart-readable incidents and bounds retained evidence", () =>
  Effect.gen(function* () {
    const home = yield* profile;
    const store = yield* MainFatalIncidentStore.pipe(Effect.provide(layerForHome(home)));
    const recordDirectory = path.join(home, "diagnostics/fatal");
    yield* Effect.promise(() => mkdir(recordDirectory, { recursive: true, mode: 0o700 }));
    yield* Effect.promise(() =>
      writeFile(path.join(recordDirectory, `${randomUUID()}.tmp`), "unpublished"),
    );
    let latest = "";
    for (let index = 0; index < MAX_FATAL_INCIDENT_FILES + 2; index += 1) {
      const value = incident(index);
      latest = yield* store.write(value);
      assert.deepEqual(JSON.parse(yield* Effect.promise(() => readFile(latest, "utf8"))), value);
    }
    const rollback = { ...incident(), occurredAt: "2020-01-01T00:00:00.000Z" };
    latest = yield* store.write(rollback);
    assert.deepEqual(JSON.parse(yield* Effect.promise(() => readFile(latest, "utf8"))), rollback);
    const directory = path.dirname(latest);
    const files = yield* Effect.promise(() => readdir(directory));
    assert.strictEqual(files.length, MAX_FATAL_INCIDENT_FILES);
    assert.isTrue(files.every((file) => file.endsWith(".json")));
    let totalBytes = 0;
    for (const name of files) {
      const info = yield* Effect.promise(() => stat(path.join(directory, name)));
      assert.strictEqual(info.mode & 0o777, 0o600);
      totalBytes += info.size;
    }
    assert.isAtMost(totalBytes, MAX_FATAL_INCIDENT_FILES * MAX_FATAL_INCIDENT_BYTES);
    assert.strictEqual((yield* Effect.promise(() => stat(directory))).mode & 0o777, 0o700);
  }),
);

it.live("refuses symlinked diagnostic directories without writing outside the Profile", () =>
  Effect.gen(function* () {
    const home = yield* profile;
    const outside = yield* profile;
    yield* Effect.promise(() => symlink(outside, path.join(home, "diagnostics")));
    const result = yield* MainFatalIncidentStore.pipe(
      Effect.flatMap((store) => store.write(incident())),
      Effect.provide(layerForHome(home)),
      Effect.result,
    );
    assert.strictEqual(result._tag, "Failure");
    assert.deepEqual(yield* Effect.promise(() => readdir(outside)), []);
  }),
);

it.live("rejects an oversized incident before publishing any record", () =>
  Effect.gen(function* () {
    const home = yield* profile;
    const result = yield* MainFatalIncidentStore.pipe(
      Effect.flatMap((store) =>
        store.write({ ...incident(), summary: "x".repeat(MAX_FATAL_INCIDENT_BYTES) }),
      ),
      Effect.provide(layerForHome(home)),
      Effect.result,
    );
    assert.strictEqual(result._tag, "Failure");
    assert.deepEqual(yield* Effect.promise(() => readdir(home)), []);
  }),
);
