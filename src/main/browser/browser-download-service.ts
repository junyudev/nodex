import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as MutableRef from "effect/MutableRef";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type {
  BrowserDownloadActionRequest,
  BrowserDownloadActionResult,
  BrowserDownloadRecord,
  BrowserDownloadsSnapshot,
} from "../../shared/browser-download";
import type { BrowserSidebarTabIdentity } from "../../shared/browser-sidebar";
import {
  normalizeBrowserDownloadHistory,
  parseBrowserDownloadHistory,
  serializeBrowserDownloadHistory,
} from "./browser-download-store";

interface BrowserDownloadItem {
  canResume(): boolean;
  cancel(): void;
  getFilename(): string;
  getReceivedBytes(): number;
  getTotalBytes(): number;
  getURL(): string;
  getURLChain(): string[];
  isPaused(): boolean;
  on(
    event: "updated",
    listener: (event: unknown, state: "progressing" | "interrupted") => void,
  ): void;
  on(
    event: "done",
    listener: (event: unknown, state: "completed" | "cancelled" | "interrupted") => void,
  ): void;
  pause(): void;
  resume(): void;
  setSavePath(path: string): void;
}

interface BrowserDownloadSession {
  on(
    event: "will-download",
    listener: (
      event: { preventDefault(): void },
      item: BrowserDownloadItem,
      webContents: { id: number } | undefined,
    ) => void,
  ): void;
  removeListener(
    event: "will-download",
    listener: (
      event: { preventDefault(): void },
      item: BrowserDownloadItem,
      webContents: { id: number } | undefined,
    ) => void,
  ): void;
}

interface BrowserDownloadShell {
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

interface BrowserDownloadLogger {
  readonly warn: (message: string, fields?: Record<string, unknown>) => void;
}

export interface BrowserDownloadRuntimeOptions {
  readonly downloadsDirectory: string;
  readonly historyFilePath: string;
  readonly idFactory?: () => string;
  readonly isAgentControlled?: (identity: BrowserSidebarTabIdentity) => boolean;
  readonly logger: BrowserDownloadLogger;
  readonly now?: () => number;
  readonly onSnapshot?: (snapshot: BrowserDownloadsSnapshot) => void;
  readonly resolveIdentity: (webContentsId: number) => BrowserSidebarTabIdentity | null;
  readonly session: BrowserDownloadSession;
  readonly shell: BrowserDownloadShell;
}

interface BrowserDownloadGrant {
  readonly webContentsId: number;
  readonly expiresAt: number;
  readonly sourceUrl: string;
}

interface BrowserDownloadState {
  readonly liveItems: ReadonlyMap<string, BrowserDownloadItem>;
  readonly records: ReadonlyMap<string, BrowserDownloadRecord>;
}

export class BrowserDownloadRuntimeError extends Schema.TaggedError<BrowserDownloadRuntimeError>()(
  "BrowserDownloadRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface BrowserDownloadRuntime {
  readonly grantAgentDownload: (
    identity: BrowserSidebarTabIdentity & { readonly webContentsId: number },
    sourceUrl: string,
    ttlMs?: number,
  ) => void;
  readonly snapshot: () => BrowserDownloadsSnapshot;
  readonly handleAction: (
    request: BrowserDownloadActionRequest,
  ) => Effect.Effect<BrowserDownloadActionResult, BrowserDownloadRuntimeError>;
  readonly clearHistory: Effect.Effect<void, BrowserDownloadRuntimeError>;
}

const runtimeError = (operation: string, cause: unknown): BrowserDownloadRuntimeError =>
  new BrowserDownloadRuntimeError({ operation, cause });

const identityKey = (identity: BrowserSidebarTabIdentity): string =>
  `${identity.browserConversationId}\0${identity.browserViewScopeId}\0${identity.browserTabId}`;

const readSourceOrigin = (item: BrowserDownloadItem): string => {
  const sourceUrl = item.getURLChain().at(-1);
  if (!sourceUrl) return "unknown:";
  try {
    return new URL(sourceUrl).origin;
  } catch {
    return "unknown:";
  }
};

const safeDownloadFilename = (value: string): string => {
  const fileName = basename(value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return fileName || "download";
};

const uniqueSavePath = (downloadsDirectory: string, fileName: string): string => {
  const initial = join(downloadsDirectory, fileName);
  if (!existsSync(initial)) return initial;
  const extension = extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  for (let sequence = 1; sequence <= 10_000; sequence += 1) {
    const candidate = join(downloadsDirectory, `${stem} (${sequence})${extension}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(downloadsDirectory, `${stem}-${randomUUID()}${extension}`);
};

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "reason" in cause &&
  typeof cause.reason === "object" &&
  cause.reason !== null &&
  "_tag" in cause.reason &&
  cause.reason._tag === "NotFound";

const snapshotFrom = (
  records: ReadonlyMap<string, BrowserDownloadRecord>,
): BrowserDownloadsSnapshot => ({
  downloads: [...records.values()].sort((left, right) => right.startedAt - left.startedAt),
});

export const makeBrowserDownloadRuntime = (
  options: BrowserDownloadRuntimeOptions,
): Effect.Effect<
  BrowserDownloadRuntime,
  BrowserDownloadRuntimeError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const now = options.now ?? Date.now;
    const idFactory = options.idFactory ?? randomUUID;
    const isAgentControlled = options.isAgentControlled ?? (() => false);
    const onSnapshot = options.onSnapshot ?? (() => undefined);
    const grants = MutableRef.make<ReadonlyMap<string, BrowserDownloadGrant>>(new Map());
    const runCallback = yield* FiberSet.makeRuntime<never, void, never>();

    const quarantine = fs
      .rename(options.historyFilePath, `${options.historyFilePath}.corrupt-${now()}`)
      .pipe(
        Effect.catch((cause) => (isNotFound(cause) ? Effect.void : Effect.fail(cause))),
        Effect.mapError((cause) => runtimeError("quarantine-history", cause)),
      );
    const loadHistory = fs.exists(options.historyFilePath).pipe(
      Effect.mapError((cause) => runtimeError("check-history", cause)),
      Effect.flatMap((exists) =>
        exists
          ? fs.readFileString(options.historyFilePath).pipe(
              Effect.mapError((cause) => runtimeError("read-history", cause)),
              Effect.flatMap((raw) =>
                Effect.try({
                  try: () => normalizeBrowserDownloadHistory(parseBrowserDownloadHistory(raw)),
                  catch: (cause) => runtimeError("parse-history", cause),
                }),
              ),
              Effect.catch(() => quarantine.pipe(Effect.as(new Map()))),
            )
          : Effect.succeed(new Map()),
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          options.logger.warn("Could not load Browser download history", {
            code: "browser-download-history-load-failed",
            error: String(error.cause),
          });
          return new Map<string, BrowserDownloadRecord>();
        }),
      ),
    );

    const initialRecords = yield* loadHistory;
    const state = yield* Ref.make<BrowserDownloadState>({
      liveItems: new Map(),
      records: initialRecords,
    });
    const writes = yield* Semaphore.make(1);

    const persist = (
      records: ReadonlyMap<string, BrowserDownloadRecord>,
    ): Effect.Effect<void, BrowserDownloadRuntimeError> => {
      const directoryPath = dirname(options.historyFilePath);
      const temporaryPath = join(
        directoryPath,
        `.${basename(options.historyFilePath)}.${now()}.${randomUUID()}.tmp`,
      );
      return fs.makeDirectory(directoryPath, { recursive: true, mode: 0o700 }).pipe(
        Effect.andThen(
          Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fs.open(temporaryPath, { flag: "wx", mode: 0o600 });
              yield* file.writeAll(
                new TextEncoder().encode(serializeBrowserDownloadHistory(records)),
              );
              yield* file.sync;
            }),
          ),
        ),
        Effect.andThen(fs.rename(temporaryPath, options.historyFilePath)),
        Effect.andThen(
          Effect.scoped(
            Effect.gen(function* () {
              const directory = yield* fs.open(directoryPath, { flag: "r" });
              yield* directory.sync;
            }),
          ),
        ),
        Effect.ensuring(fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
        Effect.mapError((cause) => runtimeError("persist-history", cause)),
      );
    };

    const publish = (next: BrowserDownloadState): Effect.Effect<void> =>
      Ref.set(state, next).pipe(
        Effect.andThen(Effect.sync(() => onSnapshot(snapshotFrom(next.records)))),
      );

    const updateRecord = (
      id: string,
      patch: Partial<BrowserDownloadRecord>,
      removeLiveItem = false,
    ): Effect.Effect<void, BrowserDownloadRuntimeError> =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const record = current.records.get(id);
          if (record === undefined) return;
          const nextRecord = { ...record, ...patch, updatedAt: now() };
          const records = normalizeBrowserDownloadHistory(
            new Map(current.records).set(id, nextRecord).values(),
          );
          const liveItems = removeLiveItem
            ? new Map([...current.liveItems].filter(([candidate]) => candidate !== id))
            : current.liveItems;
          const next = { liveItems, records };
          yield* publish(next);
          yield* persist(records);
        }),
      );

    const runDownloadCallback = (
      effect: Effect.Effect<void, BrowserDownloadRuntimeError>,
      operation: string,
    ): void => {
      runCallback(
        effect.pipe(
          Effect.catch((error) =>
            Effect.sync(() =>
              options.logger.warn("Browser download callback failed", {
                code: "browser-download-callback-failed",
                operation,
                error: String(error.cause),
              }),
            ),
          ),
        ),
      );
    };

    const pruneGrants = (): Map<string, BrowserDownloadGrant> => {
      const current = new Map(
        [...MutableRef.get(grants)].filter(([, grant]) => grant.expiresAt >= now()),
      );
      MutableRef.set(grants, current);
      return current;
    };

    const consumeAgentGrantIfRequired = (
      identity: BrowserSidebarTabIdentity,
      finalUrl: string,
      webContentsId: number,
    ): boolean => {
      const key = identityKey(identity);
      const current = pruneGrants();
      const grant = current.get(key);
      const matches = grant?.sourceUrl === finalUrl && grant.webContentsId === webContentsId;
      if (matches) {
        current.delete(key);
        MutableRef.set(grants, current);
      }
      return matches || !isAgentControlled(identity);
    };

    const commitDownload = (
      item: BrowserDownloadItem,
      record: BrowserDownloadRecord,
    ): Effect.Effect<void, BrowserDownloadRuntimeError> =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const records = normalizeBrowserDownloadHistory(
            new Map(current.records).set(record.id, record).values(),
          );
          const next = {
            liveItems: new Map(current.liveItems).set(record.id, item),
            records,
          };
          yield* publish(next);
          yield* persist(records);
        }),
      );

    const listener = (
      event: { preventDefault(): void },
      item: BrowserDownloadItem,
      webContents: { id: number } | undefined,
    ): void => {
      const identity = webContents ? options.resolveIdentity(webContents.id) : null;
      if (
        !webContents ||
        identity === null ||
        !consumeAgentGrantIfRequired(identity, item.getURL(), webContents.id)
      ) {
        event.preventDefault();
        item.cancel();
        return;
      }

      const timestamp = now();
      const id = idFactory();
      const fileName = safeDownloadFilename(item.getFilename());
      const savePath = uniqueSavePath(options.downloadsDirectory, fileName);
      item.setSavePath(savePath);
      const record: BrowserDownloadRecord = {
        id,
        browserConversationId: identity.browserConversationId,
        browserViewScopeId: identity.browserViewScopeId,
        browserTabId: identity.browserTabId,
        fileName,
        savePath,
        sourceOrigin: readSourceOrigin(item),
        status: "starting",
        receivedBytes: item.getReceivedBytes(),
        totalBytes: Math.max(0, item.getTotalBytes()),
        startedAt: timestamp,
        updatedAt: timestamp,
      };
      item.on("updated", (_updatedEvent, status) => {
        runDownloadCallback(
          updateRecord(id, {
            status: item.isPaused()
              ? "paused"
              : status === "interrupted"
                ? "interrupted"
                : "progressing",
            receivedBytes: item.getReceivedBytes(),
            totalBytes: Math.max(0, item.getTotalBytes()),
          }),
          "update-progress",
        );
      });
      item.on("done", (_doneEvent, status) => {
        runDownloadCallback(
          updateRecord(
            id,
            {
              status,
              receivedBytes: item.getReceivedBytes(),
              totalBytes: Math.max(0, item.getTotalBytes()),
              ...(status === "completed" ? { completedAt: now() } : {}),
            },
            true,
          ),
          "finish",
        );
      });
      runDownloadCallback(commitDownload(item, record), "admit");
    };
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => options.session.on("will-download", listener),
        catch: (cause) => runtimeError("install-listener", cause),
      }),
      () =>
        Effect.sync(() => {
          options.session.removeListener("will-download", listener);
          MutableRef.set(grants, new Map());
        }).pipe(
          Effect.andThen(Ref.update(state, (current) => ({ ...current, liveItems: new Map() }))),
        ),
    );
    yield* Effect.sync(() => onSnapshot(snapshotFrom(initialRecords)));

    return {
      grantAgentDownload: (identity, sourceUrl, ttlMs = 10_000) => {
        if (sourceUrl.length === 0) return;
        const current = pruneGrants();
        MutableRef.set(
          grants,
          new Map(current).set(identityKey(identity), {
            expiresAt: now() + Math.max(1, Math.min(ttlMs, 10_000)),
            sourceUrl,
            webContentsId: identity.webContentsId,
          }),
        );
      },
      snapshot: () => snapshotFrom(Ref.getUnsafe(state).records),
      handleAction: (request) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const record = current.records.get(request.downloadId);
          if (record === undefined) return { ok: false, message: "Download was not found" };
          const item = current.liveItems.get(request.downloadId);
          if (request.action === "pause") {
            if (item === undefined) return { ok: false, message: "Download is not active" };
            item.pause();
            yield* updateRecord(record.id, { status: "paused" });
            return { ok: true };
          }
          if (request.action === "resume") {
            if (item === undefined || !item.canResume()) {
              return { ok: false, message: "Download cannot be resumed" };
            }
            item.resume();
            yield* updateRecord(record.id, { status: "progressing" });
            return { ok: true };
          }
          if (request.action === "cancel") {
            if (item === undefined) return { ok: false, message: "Download is not active" };
            item.cancel();
            return { ok: true };
          }
          if (request.action === "open") {
            const error = yield* Effect.tryPromise({
              try: () => options.shell.openPath(record.savePath),
              catch: (cause) => runtimeError("open-download", cause),
            });
            return error ? { ok: false, message: error.slice(0, 512) } : { ok: true };
          }
          if (request.action === "show-in-folder") {
            yield* Effect.try({
              try: () => options.shell.showItemInFolder(record.savePath),
              catch: (cause) => runtimeError("show-download", cause),
            });
            return { ok: true };
          }
          return yield* writes.withPermits(1)(
            Effect.gen(function* () {
              const latest = yield* Ref.get(state);
              const records = new Map(latest.records);
              const liveItems = new Map(latest.liveItems);
              records.delete(request.downloadId);
              liveItems.delete(request.downloadId);
              const next = { records, liveItems };
              yield* publish(next);
              yield* persist(records);
              return { ok: true } as const;
            }),
          );
        }),
      clearHistory: writes.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const records = new Map(
            [...current.records].filter(([, record]) =>
              ["starting", "progressing", "paused"].includes(record.status),
            ),
          );
          const liveItems = new Map(
            [...current.liveItems].filter(([downloadId]) => records.has(downloadId)),
          );
          const next = { records, liveItems };
          yield* publish(next);
          yield* persist(records);
        }),
      ),
    } satisfies BrowserDownloadRuntime;
  });
