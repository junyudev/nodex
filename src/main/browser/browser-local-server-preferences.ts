import { syncEffectDirectory } from "../platform/node/filesystem-durability";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  DEFAULT_BROWSER_LOCAL_SERVER_PREFERENCES,
  type BrowserLocalServerPreferences,
  type BrowserLocalServerPreferencesUpdate,
} from "../../shared/browser-sidebar";

const MAX_EXPANDED_PROJECTS = 1_000;
const MAX_PREFERENCES_FILE_BYTES = 256 * 1_024;

const BrowserLocalServerPreferencesSchema = z
  .object({
    schemaVersion: z.literal(1),
    showMode: z.enum(["online", "all", "hidden"]),
    sortMode: z.enum(["recently-used", "origin"]),
    expandedProjectIds: z.array(z.string().trim().min(1).max(512)).max(MAX_EXPANDED_PROJECTS),
  })
  .strict();

const normalizeExpandedProjectIds = (values: readonly string[]): string[] =>
  [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && value.length <= 512),
    ),
  ].slice(-MAX_EXPANDED_PROJECTS);

const defaultPreferences = (): BrowserLocalServerPreferences => ({
  ...DEFAULT_BROWSER_LOCAL_SERVER_PREFERENCES,
  expandedProjectIds: [],
});

const copyPreferences = (
  preferences: BrowserLocalServerPreferences,
): BrowserLocalServerPreferences => ({
  ...preferences,
  expandedProjectIds: [...preferences.expandedProjectIds],
});

export class BrowserLocalServerPreferencesRuntimeError extends Schema.TaggedError<BrowserLocalServerPreferencesRuntimeError>()(
  "BrowserLocalServerPreferencesRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface BrowserLocalServerPreferencesRuntime {
  readonly snapshot: Effect.Effect<BrowserLocalServerPreferences>;
  readonly update: (
    input: BrowserLocalServerPreferencesUpdate,
  ) => Effect.Effect<BrowserLocalServerPreferences, BrowserLocalServerPreferencesRuntimeError>;
}

const runtimeError = (
  operation: string,
  cause: unknown,
): BrowserLocalServerPreferencesRuntimeError =>
  new BrowserLocalServerPreferencesRuntimeError({ operation, cause });

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "reason" in cause &&
  typeof cause.reason === "object" &&
  cause.reason !== null &&
  "_tag" in cause.reason &&
  cause.reason._tag === "NotFound";

export const makeBrowserLocalServerPreferencesRuntime = (
  filePath: string,
  now: () => number = Date.now,
): Effect.Effect<
  BrowserLocalServerPreferencesRuntime,
  BrowserLocalServerPreferencesRuntimeError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const quarantine = fs.rename(filePath, `${filePath}.corrupt-${now()}`).pipe(
      Effect.catch((cause) => (isNotFound(cause) ? Effect.void : Effect.fail(cause))),
      Effect.mapError((cause) => runtimeError("quarantine", cause)),
    );
    const load = fs.exists(filePath).pipe(
      Effect.mapError((cause) => runtimeError("check-exists", cause)),
      Effect.flatMap((exists) => {
        if (!exists) return Effect.succeed(defaultPreferences());
        return fs.readFileString(filePath).pipe(
          Effect.mapError((cause) => runtimeError("read", cause)),
          Effect.flatMap((raw) =>
            Effect.try({
              try: () => {
                if (Buffer.byteLength(raw, "utf8") > MAX_PREFERENCES_FILE_BYTES) {
                  throw new TypeError("Browser local server preferences exceed their size limit");
                }
                const parsed = BrowserLocalServerPreferencesSchema.parse(JSON.parse(raw));
                return {
                  showMode: parsed.showMode,
                  sortMode: parsed.sortMode,
                  expandedProjectIds: normalizeExpandedProjectIds(parsed.expandedProjectIds),
                } satisfies BrowserLocalServerPreferences;
              },
              catch: (cause) => runtimeError("parse", cause),
            }),
          ),
          Effect.catch(() => quarantine.pipe(Effect.as(defaultPreferences()))),
        );
      }),
    );
    const persist = (
      preferences: BrowserLocalServerPreferences,
    ): Effect.Effect<void, BrowserLocalServerPreferencesRuntimeError> => {
      const payload = `${JSON.stringify({ schemaVersion: 1, ...preferences }, null, 2)}\n`;
      if (Buffer.byteLength(payload, "utf8") > MAX_PREFERENCES_FILE_BYTES) {
        return Effect.fail(
          runtimeError(
            "serialize",
            new TypeError("Browser local server preferences exceed their size limit"),
          ),
        );
      }
      const directoryPath = dirname(filePath);
      const temporaryPath = join(
        directoryPath,
        `.${basename(filePath)}.${now()}.${randomUUID()}.tmp`,
      );
      return fs.makeDirectory(directoryPath, { recursive: true, mode: 0o700 }).pipe(
        Effect.andThen(
          Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fs.open(temporaryPath, { flag: "wx", mode: 0o600 });
              yield* file.writeAll(new TextEncoder().encode(payload));
              yield* file.sync;
            }),
          ),
        ),
        Effect.andThen(fs.rename(temporaryPath, filePath)),
        Effect.andThen(syncEffectDirectory(fs, directoryPath)),
        Effect.ensuring(fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
        Effect.mapError((cause) => runtimeError("persist", cause)),
      );
    };

    const state = yield* Ref.make(yield* load);
    const writes = yield* Semaphore.make(1);
    return {
      snapshot: Ref.get(state).pipe(Effect.map(copyPreferences)),
      update: (input) =>
        writes.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const next = {
              showMode: input.showMode ?? current.showMode,
              sortMode: input.sortMode ?? current.sortMode,
              expandedProjectIds:
                input.expandedProjectIds === undefined
                  ? [...current.expandedProjectIds]
                  : normalizeExpandedProjectIds(input.expandedProjectIds),
            } satisfies BrowserLocalServerPreferences;
            yield* persist(next);
            yield* Ref.set(state, next);
            return copyPreferences(next);
          }),
        ),
    } satisfies BrowserLocalServerPreferencesRuntime;
  });
