import { syncEffectDirectory } from "../platform/node/filesystem-durability";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { BrowserSidebarTabIdentity } from "../../shared/browser-sidebar";
import { BrowserSidebarTabIdentitySchema } from "../../shared/browser/browser-schemas";

const MAX_PAGE_COUNT = 100;
const MAX_NAVIGATION_ENTRIES = 500;
const MAX_STORE_BYTES = 64 * 1_024 * 1_024;
const MAX_URL_LENGTH = 16_384;
const MAX_TITLE_LENGTH = 2_048;
const MAX_PAGE_STATE_LENGTH = 2 * 1_024 * 1_024;

const BrowserNavigationEntrySchema = z
  .object({
    title: z.string().max(MAX_TITLE_LENGTH),
    url: z.string().max(MAX_URL_LENGTH),
    pageState: z.string().max(MAX_PAGE_STATE_LENGTH).optional(),
  })
  .strict();

const BrowserSerializedPageSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtime: z.literal("electron-webview"),
    browserStorageId: z.string().min(1).max(512),
    identity: BrowserSidebarTabIdentitySchema,
    faviconUrl: z.string().max(MAX_URL_LENGTH).optional(),
    title: z.string().max(MAX_TITLE_LENGTH),
    url: z.string().max(MAX_URL_LENGTH),
    updatedAt: z.number().finite().nonnegative(),
    navigation: z
      .object({
        currentIndex: z.number().int().nonnegative(),
        entries: z.array(BrowserNavigationEntrySchema).min(1).max(MAX_NAVIGATION_ENTRIES),
      })
      .strict(),
  })
  .strict()
  .superRefine((page, context) => {
    if (page.navigation.currentIndex < page.navigation.entries.length) return;
    context.addIssue({
      code: "custom",
      message: "Navigation currentIndex must reference an existing entry",
      path: ["navigation", "currentIndex"],
    });
  });

const BrowserPageStoreFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    pages: z.record(z.string(), BrowserSerializedPageSchema),
  })
  .strict();

export interface BrowserNavigationEntry {
  title: string;
  url: string;
  pageState?: string;
}

export interface BrowserSerializedPage {
  schemaVersion: 1;
  runtime: "electron-webview";
  browserStorageId: string;
  identity: BrowserSidebarTabIdentity;
  faviconUrl?: string;
  title: string;
  url: string;
  updatedAt: number;
  navigation: {
    currentIndex: number;
    entries: BrowserNavigationEntry[];
  };
}

export class BrowserPageRuntimeError extends Schema.TaggedError<BrowserPageRuntimeError>()(
  "BrowserPageRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface BrowserPageRuntime {
  readonly get: (browserStorageId: string) => Effect.Effect<BrowserSerializedPage | null>;
  readonly set: (page: BrowserSerializedPage) => Effect.Effect<void, BrowserPageRuntimeError>;
  readonly delete: (browserStorageId: string) => Effect.Effect<void, BrowserPageRuntimeError>;
  readonly clear: Effect.Effect<void, BrowserPageRuntimeError>;
  readonly reassociate: (
    sourceStorageId: string,
    targetStorageId: string,
  ) => Effect.Effect<void, BrowserPageRuntimeError>;
}

type PageState = HashMap.HashMap<string, BrowserSerializedPage>;

const runtimeError = (operation: string, cause: unknown): BrowserPageRuntimeError =>
  new BrowserPageRuntimeError({ operation, cause });

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "reason" in cause &&
  typeof cause.reason === "object" &&
  cause.reason !== null &&
  "_tag" in cause.reason &&
  cause.reason._tag === "NotFound";

export const makeBrowserPageRuntime = (
  filePath: string,
): Effect.Effect<BrowserPageRuntime, BrowserPageRuntimeError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const quarantine = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* fs
        .rename(filePath, `${filePath}.corrupt-${now}-${randomUUID()}`)
        .pipe(Effect.catch((cause) => (isNotFound(cause) ? Effect.void : Effect.fail(cause))));
    }).pipe(Effect.mapError((cause) => runtimeError("quarantine", cause)));
    const load = fs.exists(filePath).pipe(
      Effect.mapError((cause) => runtimeError("check-exists", cause)),
      Effect.flatMap((exists) => {
        if (!exists) return Effect.succeed(HashMap.empty<string, BrowserSerializedPage>());
        return fs.readFileString(filePath).pipe(
          Effect.mapError((cause) => runtimeError("read", cause)),
          Effect.flatMap((raw) =>
            Effect.try({
              try: () => decodePages(raw),
              catch: (cause) => runtimeError("parse", cause),
            }).pipe(
              Effect.catch(() =>
                quarantine.pipe(Effect.as(HashMap.empty<string, BrowserSerializedPage>())),
              ),
            ),
          ),
        );
      }),
    );
    const persist = (pages: PageState) => {
      const payload = encodePages(pages);
      const directoryPath = dirname(filePath);
      const temporaryPath = join(directoryPath, `.${basename(filePath)}.${randomUUID()}.tmp`);
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
      get: (browserStorageId) =>
        Ref.get(state).pipe(
          Effect.map((pages) => Option.getOrNull(HashMap.get(pages, browserStorageId))),
        ),
      set: (page) =>
        writes.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const normalized = yield* Effect.try({
              try: () => normalizePage(page, now),
              catch: (cause) => runtimeError("validate-page", cause),
            });
            const current = yield* Ref.get(state);
            const next = limitPages(HashMap.set(current, normalized.browserStorageId, normalized));
            yield* persist(next);
            yield* Ref.set(state, next);
          }),
        ),
      delete: (browserStorageId) =>
        writes.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            if (Option.isNone(HashMap.get(current, browserStorageId))) return;
            const next = HashMap.remove(current, browserStorageId);
            yield* persist(next);
            yield* Ref.set(state, next);
          }),
        ),
      clear: writes.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (HashMap.isEmpty(current)) return;
          const next = HashMap.empty<string, BrowserSerializedPage>();
          yield* persist(next);
          yield* Ref.set(state, next);
        }),
      ),
      reassociate: (sourceStorageId, targetStorageId) =>
        writes.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const source = Option.getOrUndefined(HashMap.get(current, sourceStorageId));
            if (!source) return;
            const updatedAt = yield* Clock.currentTimeMillis;
            const next = limitPages(
              HashMap.set(HashMap.remove(current, sourceStorageId), targetStorageId, {
                ...source,
                browserStorageId: targetStorageId,
                updatedAt,
              }),
            );
            yield* persist(next);
            yield* Ref.set(state, next);
          }),
        ),
    } satisfies BrowserPageRuntime;
  });

const decodePages = (raw: string): PageState => {
  if (Buffer.byteLength(raw, "utf8") > MAX_STORE_BYTES) {
    throw new TypeError("Browser page snapshots exceed their size limit");
  }
  const parsed = BrowserPageStoreFileSchema.parse(JSON.parse(raw));
  return limitPages(
    HashMap.fromIterable(
      Object.entries(parsed.pages)
        .filter(([browserStorageId, page]) => browserStorageId === page.browserStorageId)
        .map(([browserStorageId, page]) => [browserStorageId, page] as const),
    ),
  );
};

const normalizePage = (page: BrowserSerializedPage, now: number): BrowserSerializedPage => {
  const entries = page.navigation.entries.slice(-MAX_NAVIGATION_ENTRIES);
  const droppedCount = page.navigation.entries.length - entries.length;
  const currentIndex = Math.max(
    0,
    Math.min(entries.length - 1, page.navigation.currentIndex - droppedCount),
  );
  return BrowserSerializedPageSchema.parse({
    ...page,
    updatedAt: Number.isFinite(page.updatedAt) ? page.updatedAt : now,
    navigation: { currentIndex, entries },
  });
};

const limitPages = (state: PageState): PageState => {
  const ordered = [...HashMap.values(state)].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  const pages: BrowserSerializedPage[] = [];
  let bytes = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, pages: {} }), "utf8") + 1;
  for (const page of ordered.slice(0, MAX_PAGE_COUNT)) {
    const entryBytes =
      Buffer.byteLength(JSON.stringify(page.browserStorageId), "utf8") +
      1 +
      Buffer.byteLength(JSON.stringify(page), "utf8") +
      (pages.length > 0 ? 1 : 0);
    if (bytes + entryBytes > MAX_STORE_BYTES) break;
    pages.push(page);
    bytes += entryBytes;
  }
  return HashMap.fromIterable(pages.map((page) => [page.browserStorageId, page] as const));
};

const encodePages = (state: PageState): string => {
  const payload = `${JSON.stringify({ schemaVersion: 1, pages: Object.fromEntries(state) })}\n`;
  if (Buffer.byteLength(payload, "utf8") <= MAX_STORE_BYTES) return payload;
  throw new TypeError("Browser page snapshots exceed their size limit");
};
