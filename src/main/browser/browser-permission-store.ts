import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { z } from "zod";
import { syncEffectDirectory } from "../platform/node/filesystem-durability";
import {
  BROWSER_SITE_PERMISSION_NAMES,
  type BrowserSitePermissionName,
} from "../../shared/browser/browser-permissions";

const DecisionSchema = z
  .object({
    origin: z.string().refine((value) => permissionOrigin(value) === value),
    permission: z.enum(BROWSER_SITE_PERMISSION_NAMES),
    state: z.enum(["allow", "block"]),
  })
  .strict();
const StoreSchema = z
  .object({
    schemaVersion: z.literal(1),
    decisions: z.array(DecisionSchema).max(10_000),
  })
  .strict();
type Decision = z.infer<typeof DecisionSchema>;

export class BrowserPermissionStoreError extends Schema.TaggedError<BrowserPermissionStoreError>()(
  "BrowserPermissionStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface BrowserPermissionStore {
  /** Synchronous snapshot for Electron's permission-check callback. */
  readonly get: (
    origin: string,
    permission: BrowserSitePermissionName,
  ) => Decision["state"] | undefined;
  readonly set: (
    origin: string,
    permissions: readonly BrowserSitePermissionName[],
    state: Decision["state"],
  ) => Effect.Effect<void, BrowserPermissionStoreError>;
  readonly reset: (
    origin: string,
    permission?: BrowserSitePermissionName,
  ) => Effect.Effect<void, BrowserPermissionStoreError>;
}

/** Opaque origins cannot retain permission grants. */
export function permissionOrigin(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

const decisionKey = (origin: string, permission: BrowserSitePermissionName) =>
  `${origin}\0${permission}`;

export const makeBrowserPermissionStore = (
  filePath: string,
): Effect.Effect<BrowserPermissionStore, BrowserPermissionStoreError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const error = (operation: string, cause: unknown) =>
      new BrowserPermissionStoreError({ operation, cause });
    const loaded = yield* Effect.gen(function* () {
      if (!(yield* fs.exists(filePath))) return [];
      const raw = yield* fs.readFileString(filePath);
      const parsed = yield* Effect.try({
        try: () => {
          if (raw.length > 4 * 1024 * 1024) throw new Error("Permission store is too large");
          return StoreSchema.parse(JSON.parse(raw)).decisions;
        },
        catch: (cause) => error("decode", cause),
      }).pipe(
        Effect.catch(() =>
          fs
            .rename(filePath, `${filePath}.corrupt-${randomUUID()}`)
            .pipe(Effect.as([] as Decision[])),
        ),
      );
      return parsed;
    }).pipe(Effect.mapError((cause) => error("load", cause)));
    const state = yield* Ref.make(
      new Map(loaded.map((value) => [decisionKey(value.origin, value.permission), value])),
    );
    const writes = yield* Semaphore.make(1);
    const mutate = (update: (current: Map<string, Decision>) => Map<string, Decision>) =>
      writes
        .withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const { next, payload } = yield* Effect.try({
              try: () => {
                const next = update(current);
                const payload = JSON.stringify(
                  StoreSchema.parse({ schemaVersion: 1, decisions: [...next.values()] }),
                );
                if (payload.length > 4 * 1024 * 1024)
                  throw new Error("Permission store is too large");
                return { next, payload };
              },
              catch: (cause) => error("validate", cause),
            });
            const directory = dirname(filePath);
            const temporaryPath = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);
            yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
            yield* Effect.gen(function* () {
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const file = yield* fs.open(temporaryPath, { flag: "wx", mode: 0o600 });
                  yield* file.writeAll(new TextEncoder().encode(payload));
                  yield* file.sync;
                }),
              );
              yield* fs.rename(temporaryPath, filePath);
              yield* syncEffectDirectory(fs, directory);
              yield* Ref.set(state, next);
            }).pipe(Effect.ensuring(fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore)));
          }),
        )
        .pipe(Effect.mapError((cause) => error("persist", cause)));
    return {
      get: (origin, permission) => Ref.getUnsafe(state).get(decisionKey(origin, permission))?.state,
      set: (origin, permissions, value) =>
        mutate((current) => {
          const next = new Map(current);
          for (const permission of permissions) {
            const decision = DecisionSchema.parse({ origin, permission, state: value });
            next.set(decisionKey(origin, permission), decision);
          }
          return next;
        }),
      reset: (origin, permission) =>
        mutate(
          (current) =>
            new Map(
              [...current].filter(
                ([, value]) =>
                  value.origin !== origin ||
                  (permission !== undefined && value.permission !== permission),
              ),
            ),
        ),
    };
  });
