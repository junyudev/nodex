import { inboxScopeKey, type InboxScope } from "@nodex/mobile-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Connection } from "./connection";
import { Platform } from "./platform";
import { createProjection } from "./projection";
import { reconnectDelay } from "./connection";
import { uploadImages } from "./files";
import { errorMessage, mintId } from "./operations";
import type { LocalImage } from "./platform";
import { readStored } from "./storage";
import { disconnected, RpcFailure } from "./rpc-client";

export type PendingCapture = {
  captureId: string;
  scope: InboxScope;
  text: string;
  images: LocalImage[];
  createdAt: number;
  state: "waiting" | "sending" | "failed";
  error: string | null;
};

type DeliveryIdentity = { operationId: string; issuedAt: number };

type Entry = {
  /** JSON tuple of the enrolled Space and Member. Unassigned old captures remain local. */
  hostId: string;
  pageId: string;
  documentId: string;
  delivered: boolean;
  /** Check for an existing Page before minting a new identity for an expired attempt. */
  delivery: DeliveryIdentity | "check-existing" | null;
  prepared: boolean;
  ownedFiles: string[];
  capture: PendingCapture;
};

const STORAGE_KEY = "nodex.mobile.outbox.v1";
// The capture RPC forwards this Core rejection as a message.
const EXPIRED_DELIVERY =
  "This operation is outside Core's retained idempotency window; do not replay it implicitly";

export const makeOutbox = Effect.gen(function* () {
  const platform = yield* Platform;
  const connection = yield* Connection;
  const wake = yield* Queue.sliding<void>(1);
  yield* Effect.addFinalizer(() => Queue.shutdown(wake));
  const restored = readStored<Entry[]>(platform.storage, STORAGE_KEY, []);
  const store = createProjection(
    restored.map((entry): Entry =>
      !entry.delivered && entry.capture.state === "sending"
        ? { ...entry, capture: { ...entry.capture, state: "waiting" } }
        : entry,
    ),
  );
  const delivered = createProjection(0);
  let failures = 0;
  const notify = Queue.offer(wake, undefined).pipe(Effect.asVoid);
  function persist(next: Entry[]) {
    platform.storage.set(STORAGE_KEY, JSON.stringify(next));
    store.setState(next, true);
  }
  const find = (id: string) => store.getState().find((entry) => entry.capture.captureId === id);
  function replace(id: string, transform: (entry: Entry) => Entry) {
    persist(
      store.getState().map((entry) => (entry.capture.captureId === id ? transform(entry) : entry)),
    );
  }
  function removeFiles(uris: readonly string[]) {
    for (const uri of uris) {
      try {
        platform.files.remove(uri);
      } catch {
        /* Retain the committed result. */
      }
    }
  }
  function remove(entries: Entry[]) {
    if (!entries.length) return;
    const removed = new Set(entries);
    persist(store.getState().filter((entry) => !removed.has(entry)));
    for (const entry of entries) removeFiles(entry.ownedFiles);
  }
  const updateState = (id: string, state: PendingCapture["state"], error: string | null = null) => {
    if (find(id))
      replace(id, (entry) => ({ ...entry, capture: { ...entry.capture, state, error } }));
  };
  const prepare = Effect.fn("MobileOutbox.prepare")(function* (entry: Entry) {
    if (entry.prepared) return entry.capture.images;
    const id = entry.capture.captureId;
    const copies: LocalImage[] = [];
    let committed = false;
    return yield* Effect.gen(function* () {
      for (const [index, image] of entry.capture.images.entries()) {
        yield* Effect.acquireUseRelease(
          platform.compress(image),
          (compressed) =>
            Effect.try({
              try: () => {
                if (!find(id)) throw disconnected();
                const uri = platform.files.uri("documents", `capture-${id}-${index}.jpg`);
                removeFiles([uri]);
                platform.files.copy(compressed.uri, uri);
                copies.push({ ...compressed, uri });
              },
              catch: (error) =>
                error instanceof RpcFailure
                  ? error
                  : new RpcFailure(
                      "invalid_params",
                      "An image could not be prepared for sending.",
                      false,
                    ),
            }),
          (compressed) =>
            Effect.sync(() => {
              if (compressed.uri !== image.uri) removeFiles([compressed.uri]);
            }),
        );
      }
      replace(id, (current) => ({
        ...current,
        prepared: true,
        ownedFiles: [...current.ownedFiles, ...copies.map((image) => image.uri)],
        capture: { ...current.capture, images: copies },
      }));
      committed = true;
      return copies;
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure" && !committed
          ? Effect.sync(() => removeFiles(copies.map((image) => image.uri)))
          : Effect.void,
      ),
    );
  });
  const alreadyDelivered = (pageId: string) =>
    connection.rpc.request("inbox.message", { entryId: pageId }).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        error.code === "not_found" ? Effect.succeed(false) : Effect.fail(error),
      ),
    );
  const deliver = Effect.fn("MobileOutbox.deliver")(function* (entry: Entry) {
    const link = yield* connection.requireLink;
    if (link.hello.host.id !== entry.hostId) return yield* Effect.fail(disconnected());
    const id = entry.capture.captureId;
    const assertCurrent = () =>
      connection
        .assertLink(link)
        .pipe(
          Effect.andThen(
            Effect.suspend(() => (find(id) ? Effect.void : Effect.fail(disconnected()))),
          ),
        );
    updateState(id, "sending");
    yield* assertCurrent();
    // A send whose answer never came may have landed, and the same attachment can now upload as a
    // different File, so what is already there is settled before anything is rebuilt.
    if (!entry.delivery || !(yield* alreadyDelivered(entry.pageId))) {
      const images = yield* prepare(entry);
      const fileRefs = yield* uploadImages(platform, connection.rpc, images, assertCurrent);
      yield* assertCurrent();
      let delivery = entry.delivery;
      if (!delivery || delivery === "check-existing") {
        const issuedAt = platform.now();
        delivery = { issuedAt, operationId: mintId(platform, issuedAt) };
        const identity = delivery;
        replace(id, (current) => ({ ...current, delivery: identity }));
      }
      yield* connection.rpc.request("inbox.capture", {
        ...delivery,
        pageId: entry.pageId,
        documentId: entry.documentId,
        scope: entry.capture.scope,
        text: entry.capture.text,
        fileRefs,
      });
    }
    if (!find(id)) return;
    replace(id, (current) => ({ ...current, delivered: true }));
    failures = 0;
    delivered.setState(delivered.getState() + 1, true);
  });
  const drain = Effect.gen(function* () {
    while (true) {
      const link = connection.activeLink();
      if (!link) return;
      const entry = store
        .getState()
        .find(
          (item) =>
            item.hostId === link.hello.host.id &&
            !item.delivered &&
            item.capture.state === "waiting",
        );
      if (!entry) return;
      const result = yield* deliver(entry).pipe(Effect.result);
      if (result._tag === "Success" || !find(entry.capture.captureId)) continue;
      const error = result.failure;
      if (!(error instanceof RpcFailure) || !error.retryable) {
        failures = 0;
        updateState(
          entry.capture.captureId,
          "failed",
          errorMessage(error, "The capture could not be sent."),
        );
        continue;
      }
      updateState(entry.capture.captureId, "waiting");
      if (connection.activeLink() !== link) return;
      // Reconnect and explicit retry wake the same ordered lane and reset its backoff.
      yield* Effect.raceFirst(Effect.sleep(reconnectDelay(platform, failures++)), Queue.take(wake));
    }
  });
  yield* Effect.gen(function* () {
    while (true) {
      yield* Queue.take(wake);
      yield* drain.pipe(Effect.ignoreCause);
    }
  }).pipe(Effect.forkScoped({ startImmediately: true }));
  yield* connection.state.changes.pipe(
    Stream.runForEach(({ status }) => {
      if (status !== "connected") return Effect.void;
      failures = 0;
      return notify;
    }),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* notify;
  return {
    store,
    delivered: delivered.changes,
    captureToInbox: (input: { scope: InboxScope; text: string; images: LocalImage[] }) =>
      Effect.gen(function* () {
        const hostId = connection.activeHostId();
        if (!hostId) return yield* Effect.fail(disconnected());
        const createdAt = platform.now();
        const captureId = mintId(platform, createdAt);
        const images: LocalImage[] = [];
        yield* Effect.try({
          try: () => {
            for (const [index, image] of input.images.entries()) {
              const extension = /\.[a-z0-9]{1,10}$/iu.exec(image.name)?.[0] ?? "";
              const uri = platform.files.uri(
                "documents",
                `capture-${captureId}-${index}.original${extension}`,
              );
              platform.files.copy(image.uri, uri);
              images.push({ ...image, uri });
            }
            const capture: PendingCapture = {
              ...input,
              captureId,
              createdAt,
              images,
              state: "waiting",
              error: null,
            };
            persist([
              ...store.getState(),
              {
                hostId,
                pageId: mintId(platform, createdAt),
                documentId: mintId(platform, createdAt),
                delivered: false,
                delivery: null,
                prepared: images.length === 0,
                ownedFiles: images.map((image) => image.uri),
                capture,
              },
            ]);
          },
          catch: () => {
            removeFiles(images.map((image) => image.uri));
            return new RpcFailure("internal", "Could not save the capture on this phone.", false);
          },
        });
        yield* notify;
        return captureId;
      }),
    retryCapture: (captureId: string) =>
      Effect.gen(function* () {
        const entry = find(captureId);
        if (
          !entry ||
          entry.hostId !== connection.activeHostId() ||
          entry.capture.state !== "failed"
        )
          return;
        replace(captureId, (current) => ({
          ...current,
          delivery:
            current.capture.error === EXPIRED_DELIVERY ? "check-existing" : current.delivery,
          capture: { ...current.capture, state: "waiting", error: null },
        }));
        failures = 0;
        yield* notify;
      }),
    discardCapture: (captureId: string) =>
      Effect.gen(function* () {
        const entry = find(captureId);
        if (!entry || entry.hostId !== connection.activeHostId()) return;
        remove([entry]);
        failures = 0;
        yield* notify;
      }),
    observeWindow: (hostId: string, pageIds: Set<string>) =>
      Effect.sync(() =>
        remove(
          store.getState().filter((entry) => entry.hostId === hostId && pageIds.has(entry.pageId)),
        ),
      ),
    visiblePending: (hostId: string | null, scope: InboxScope, pageIds: ReadonlySet<string>) =>
      store
        .getState()
        .filter(
          (entry) =>
            entry.hostId === hostId &&
            (scope.kind === "all" || inboxScopeKey(entry.capture.scope) === inboxScopeKey(scope)) &&
            !pageIds.has(entry.pageId),
        )
        .map((entry) => entry.capture),
    forgetHost: (hostId: string) =>
      Effect.sync(() => remove(store.getState().filter((entry) => entry.hostId === hostId))),
  };
});
export type CaptureOutbox = Effect.Success<typeof makeOutbox>;
export class Outbox extends Context.Service<Outbox, CaptureOutbox>()("nodex/mobile/Outbox") {}
