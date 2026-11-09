import { MOBILE_FILE_CHUNK_BYTES, MOBILE_UPLOAD_MAX_BYTES } from "@nodex/mobile-protocol";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { Connection, reconnectDelay } from "./connection";
import { encodeUtf8, fromBase64, toBase64 } from "./encoding";
import { errorMessage, retryOperation } from "./operations";
import { Platform, type LocalImage } from "./platform";
import { createProjection, type Projection } from "./projection";
import { readStored } from "./storage";
import { disconnected, RpcFailure, type MobileRpc } from "./rpc-client";

export const uploadImages = Effect.fn("MobileFiles.uploadImages")(function* (
  platform: Platform["Service"],
  rpc: MobileRpc,
  images: readonly LocalImage[],
  assertCurrent: () => Effect.Effect<void, RpcFailure>,
) {
  // A complete retry batch must fit the Device's wire budget after base64 expansion.
  const uploads = yield* Effect.try({
    try: () => {
      const uploads = images.map((image) => {
        const size = platform.files.size(image.uri);
        if (
          size === null ||
          !Number.isSafeInteger(size) ||
          size <= 0 ||
          size > MOBILE_UPLOAD_MAX_BYTES
        )
          throw new RpcFailure(
            "invalid_params",
            "An image is missing or too large to send.",
            false,
          );
        return { image, size };
      });
      if (uploads.reduce((total, upload) => total + upload.size, 0) > MOBILE_UPLOAD_MAX_BYTES)
        throw new RpcFailure(
          "invalid_params",
          "These images are too large to send together.",
          false,
        );
      return uploads;
    },
    catch: (error) =>
      error instanceof RpcFailure
        ? error
        : new RpcFailure("invalid_params", "An image could not be read.", false),
  });
  const refs: string[] = [];
  for (const { image, size } of uploads) {
    yield* assertCurrent();
    const { uploadId } = yield* rpc.request("files.upload.begin", {
      name: image.name,
      mimeType: image.mimeType,
      size,
    });
    for (let offset = 0; offset < size; offset += MOBILE_FILE_CHUNK_BYTES) {
      yield* assertCurrent();
      const length = Math.min(MOBILE_FILE_CHUNK_BYTES, size - offset);
      const bytes = yield* platform
        .readFile(image.uri, offset, length)
        .pipe(
          Effect.mapError(
            () => new RpcFailure("invalid_params", "An image could not be read.", false),
          ),
        );
      if (bytes.length !== length)
        return yield* Effect.fail(
          new RpcFailure("invalid_params", "An image changed while sending.", false),
        );
      yield* assertCurrent();
      yield* rpc.request("files.upload.chunk", { uploadId, offset, base64: toBase64(bytes) });
    }
    yield* assertCurrent();
    const { ref } = yield* rpc.request("files.upload.commit", { uploadId });
    refs.push(ref);
  }
  return refs;
});

const CACHE_LIMIT = 64 * 1024 * 1024;
const CACHE_KEY = "nodex.mobile.file-cache.v1";
const MAX_VERSION_RESTARTS = 2;

type FileState = { uri: string | null; loading: boolean; error: string | null };
const emptyFile: FileState = { uri: null, loading: false, error: null };

type CacheEntry = {
  uri: string;
  hostId: string;
  size: number;
  usedAt: number;
  complete: boolean;
  version?: string | null;
};

function fileExtension(name: string | null, mimeType: string | null) {
  const suffix = name && /\.[a-z0-9]{1,10}$/iu.exec(name)?.[0];
  if (suffix) return suffix;
  const byMime: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
  };
  return (mimeType && Object.hasOwn(byMime, mimeType) ? byMime[mimeType] : undefined) ?? ".bin";
}

export const makeFileCache = Effect.gen(function* () {
  const platform = yield* Platform;
  const connection = yield* Connection;
  const owner = yield* Scope.Scope;
  const cacheWriter = yield* Semaphore.make(1);
  const entries = new Map(
    Object.entries(readStored<Record<string, CacheEntry>>(platform.storage, CACHE_KEY, {})),
  );
  type Resource = {
    hostId: string;
    store: Projection<FileState>;
    attach: Effect.Effect<Effect.Effect<void>, RpcFailure>;
    resolve: Effect.Effect<string, RpcFailure>;
    inUse(): boolean;
    reconnect: Effect.Effect<void>;
    dispose: Effect.Effect<void>;
  };
  const resources = new Map<string, Resource>();
  const emptyStore = createProjection(emptyFile);
  const save = () => platform.storage.set(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  function evict(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    platform.files.remove(entry.uri);
    entries.delete(key);
  }
  const tooLarge = () =>
    new RpcFailure("invalid_result", "This file is too large for the phone’s file cache.", false);
  const reserve = Effect.fnUntraced(function* (key: string, size: number) {
    if (size < 0 || size > CACHE_LIMIT) return yield* Effect.fail(tooLarge());
    let reserved = [...entries.values()].reduce((sum, entry) => sum + entry.size, 0);
    for (const [candidate, entry] of [...entries].sort(([, a], [, b]) => a.usedAt - b.usedAt)) {
      if (reserved + size <= CACHE_LIMIT) break;
      if (candidate === key || resources.get(candidate)?.inUse()) continue;
      const reader = resources.get(candidate);
      if (reader) yield* reader.dispose;
      evict(candidate);
      resources.delete(candidate);
      save();
      reserved -= entry.size;
    }
    if (reserved + size > CACHE_LIMIT) return yield* Effect.fail(tooLarge());
  });
  const resource = Effect.fnUntraced(function* (key: string, hostId: string, ref: string) {
    const scope = yield* Scope.fork(owner);
    const wake = yield* Queue.sliding<void>(1);
    yield* Scope.addFinalizer(scope, Queue.shutdown(wake));
    let references = 0;
    let completion: Deferred.Deferred<string, RpcFailure> | null = null;
    let failures = 0;
    let versionRestarts = 0;
    let removed = false;
    const cached = entries.get(key);
    const store = createProjection<FileState>(
      cached?.complete && platform.files.size(cached.uri) === cached.size
        ? { ...emptyFile, uri: cached.uri }
        : emptyFile,
    );
    const notify = Queue.offer(wake, undefined).pipe(Effect.asVoid);
    const download = Effect.fn("MobileFiles.download")(function* () {
      const link = yield* connection.requireLink;
      if (link.hello.host.id !== hostId || removed) return yield* Effect.fail(disconnected());
      let current = entries.get(key);
      const available = current ? platform.files.size(current.uri) : null;
      if (current && (available === null || available > current.size || current.version == null)) {
        evict(key);
        current = undefined;
        save();
      }
      let offset = current ? (available ?? 0) : 0;
      while (!current || offset < current.size) {
        yield* connection.assertLink(link);
        const result = yield* connection.rpc.request("files.read", {
          ref,
          offset,
          length: MOBILE_FILE_CHUNK_BYTES,
          version: current?.version,
        });
        yield* connection.assertLink(link);
        if (current && current.version !== result.version)
          return yield* Effect.fail(
            new RpcFailure("conflict", "This file changed while downloading.", false),
          );
        const bytes = yield* Effect.try({
          try: () => fromBase64(result.base64),
          catch: () =>
            new RpcFailure(
              "invalid_result",
              "Your desktop sent part of this file incorrectly.",
              false,
            ),
        });
        const remaining = result.totalBytes - offset;
        if (
          remaining < 0 ||
          bytes.length > MOBILE_FILE_CHUNK_BYTES ||
          bytes.length > remaining ||
          (remaining > 0 && !bytes.length) ||
          (current && current.size !== result.totalBytes)
        ) {
          evict(key);
          save();
          return yield* Effect.fail(
            new RpcFailure(
              "invalid_result",
              "Your desktop sent part of this file incorrectly.",
              false,
            ),
          );
        }
        if (!current) {
          current = yield* cacheWriter.withPermits(1)(
            Effect.gen(function* () {
              yield* reserve(key, result.totalBytes);
              const uri = platform.files.uri(
                "cache",
                `file-${key}${fileExtension(result.name, result.mimeType)}`,
              );
              platform.files.remove(uri);
              const entry: CacheEntry = {
                uri,
                hostId,
                size: result.totalBytes,
                usedAt: platform.now(),
                complete: false,
                version: result.version,
              };
              entries.set(key, entry);
              save();
              return entry;
            }),
          );
        }
        yield* platform
          .appendFile(current.uri, bytes)
          .pipe(
            Effect.mapError(
              () => new RpcFailure("internal", "This file could not be saved on the phone.", false),
            ),
          );
        offset += bytes.length;
      }
      current.complete = true;
      current.usedAt = platform.now();
      save();
      failures = 0;
      versionRestarts = 0;
      return current.uri;
    });
    const attempt = download().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        const error = Cause.squash(cause);
        return Effect.fail(
          error instanceof RpcFailure
            ? error
            : new RpcFailure("internal", "This file could not be opened on the phone.", false),
        );
      }),
      Effect.retry({
        times: MAX_VERSION_RESTARTS,
        while: (error) => {
          if (error.code !== "conflict") return false;
          evict(key);
          save();
          return ++versionRestarts <= MAX_VERSION_RESTARTS;
        },
      }),
    );
    yield* Effect.gen(function* () {
      while (true) {
        yield* Queue.take(wake);
        if (
          removed ||
          !references ||
          store.getState().uri ||
          versionRestarts > MAX_VERSION_RESTARTS
        )
          continue;
        const pending = completion ?? (yield* Deferred.make<string, RpcFailure>());
        completion = pending;
        store.setState({ loading: true, error: null });
        const result = yield* attempt.pipe(Effect.result);
        completion = null;
        if (result._tag === "Success") {
          store.setState({ uri: result.success, loading: false, error: null }, true);
          yield* Deferred.succeed(pending, result.success);
          continue;
        }
        const error = result.failure;
        store.setState({
          loading: false,
          error: errorMessage(error, "This file could not be opened."),
        });
        yield* Deferred.fail(pending, error);
        if (!error.retryable || !references || !connection.activeLink()) continue;
        yield* Effect.raceFirst(
          Effect.sleep(reconnectDelay(platform, failures++)),
          Queue.take(wake),
        );
        yield* notify;
      }
    }).pipe(Effect.forkIn(scope, { startImmediately: true }));
    yield* Scope.addFinalizer(
      scope,
      Effect.gen(function* () {
        removed = true;
        if (completion) yield* Deferred.fail(completion, disconnected());
      }),
    );
    const attach = Effect.gen(function* () {
      if (removed) return yield* Effect.fail(disconnected());
      if (!references && !completion) versionRestarts = 0;
      references++;
      const entry = entries.get(key);
      if (entry?.complete && store.getState().uri) {
        if (platform.files.size(entry.uri) !== entry.size) {
          evict(key);
          store.setState(emptyFile, true);
        } else entry.usedAt = platform.now();
        save();
      }
      yield* notify;
      let attached = true;
      return Effect.sync(() => {
        if (attached) {
          attached = false;
          references--;
        }
      });
    });
    const resolve = Effect.acquireUseRelease(
      attach,
      () =>
        Effect.gen(function* () {
          const uri = store.getState().uri;
          if (uri) return uri;
          if (versionRestarts > MAX_VERSION_RESTARTS)
            return yield* Effect.fail(
              new RpcFailure(
                "conflict",
                store.getState().error ?? "This file changed while downloading.",
                false,
              ),
            );
          const pending = completion ?? (yield* Deferred.make<string, RpcFailure>());
          completion = pending;
          yield* notify;
          return yield* Deferred.await(pending);
        }),
      (detach) => detach,
    );
    return {
      hostId,
      store,
      attach,
      resolve,
      inUse: () => references > 0 || completion !== null,
      reconnect: Effect.sync(() => {
        failures = 0;
      }).pipe(Effect.andThen(notify)),
      dispose: Scope.close(scope, Exit.void),
    };
  });
  const get = Effect.fnUntraced(function* (hostId: string | null, ref: string | null) {
    if (!hostId || !ref)
      return {
        store: emptyStore,
        attach: Effect.succeed(Effect.void),
        resolve: Effect.fail(disconnected()),
      };
    const key = bytesToHex(sha256(encodeUtf8(JSON.stringify([hostId, ref]))));
    const existing = resources.get(key);
    if (existing) return existing;
    const item = yield* resource(key, hostId, ref);
    resources.set(key, item);
    return item;
  });
  yield* connection.state.changes.pipe(
    Stream.runForEach(({ status }) =>
      Effect.gen(function* () {
        if (status !== "connected") return;
        for (const item of resources.values()) yield* item.reconnect;
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  const withImageUploads = Effect.fn("MobileFiles.withImageUploads")(function* <T, E>(
    images: LocalImage[],
    run: (fileRefs: string[]) => Effect.Effect<T, E>,
  ) {
    const compressed: LocalImage[] = [];
    const originals = new Set(images.map((image) => image.uri));
    return yield* Effect.scoped(
      retryOperation(connection, (link) =>
        Effect.gen(function* () {
          for (const image of images.slice(compressed.length)) {
            yield* connection.assertLink(link);
            const prepared = yield* Effect.acquireRelease(
              platform
                .compress(image)
                .pipe(
                  Effect.mapError(
                    () =>
                      new RpcFailure(
                        "invalid_params",
                        "An image could not be prepared for sending.",
                        false,
                      ),
                  ),
                ),
              (prepared) =>
                Effect.sync(() => {
                  if (originals.has(prepared.uri)) return;
                  try {
                    platform.files.remove(prepared.uri);
                  } catch {
                    /* Retain the upload result. */
                  }
                }),
            );
            compressed.push(prepared);
          }
          const refs = yield* uploadImages(platform, connection.rpc, compressed, () =>
            connection.assertLink(link),
          );
          yield* connection.assertLink(link);
          return yield* run(refs);
        }),
      ),
    );
  });
  return {
    get,
    withImageUploads,
    // A document can ask for its images before the channel is up; they load once it is.
    resolve: (ref: string) =>
      Effect.suspend(() => get(connection.activeHostId(), ref)).pipe(
        Effect.flatMap((file) => file.resolve),
        Effect.retry({
          schedule: Schedule.spaced("2 seconds"),
          while: (error) => error.code === "disconnected",
        }),
      ),
    forgetHost: (hostId: string) =>
      Effect.gen(function* () {
        for (const [key, item] of resources) {
          if (item.hostId === hostId) {
            yield* item.dispose;
            resources.delete(key);
          }
        }
        for (const [key, entry] of entries) if (entry.hostId === hostId) evict(key);
        save();
      }),
  };
});
export type MobileFiles = Effect.Success<typeof makeFileCache>;
export class Files extends Context.Service<Files, MobileFiles>()("nodex/mobile/Files") {}
