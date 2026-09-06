import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Y from "yjs";
import { createPageDocument } from "../../shared/block-documents/page-document";
import type {
  DocumentSyncRealtimeEvent,
  DocumentSyncResponse,
} from "../../shared/block-documents/document-sync";
import type { ContentAccessContext } from "../../shared/content-access-context";
import { NodexYProvider } from "../../renderer/lib/nodex-y-provider";
import { CoreModuleResponseError } from "./core-client";
import { CoreEventCompatibilityError } from "./uds-http";
import { FakeCoreClient, createFakeCoreHandshake } from "./testing/fake-core-client";
import { makeDesktopDocumentSessionHarness } from "./testing/desktop-document-session-harness.test-support";
import type { CoreGenerationClient } from "./core-generation-client";

const documentId = "document:recovery";
const scopes: ContentAccessContext[] = [
  { kind: "library" },
  { kind: "project", projectId: "project:test" },
];

function fixture() {
  const server = createPageDocument({ documentId, initialTitle: "Base" }).document;
  const client = new FakeCoreClient();
  Object.assign(client, {
    handshake: createFakeCoreHandshake({
      connectionBinding: "binding:test",
      libraryId: "library:test",
      profileId: "profile:test",
      storeEpoch: "epoch:test",
    }),
    forProject: () => client,
    documentSync: async () => ({
      documentId,
      storeEpoch: "epoch:test",
      generation: 1,
      headSeq: 0,
      stateVector: Y.encodeStateVector(server),
      update: Y.encodeStateAsUpdate(server),
    }),
    documentPublishAwareness: async () => ({ accepted: true }),
  });
  return { client: client as FakeCoreClient & CoreGenerationClient, server };
}

const withProvider = Effect.fn("DesktopDocumentRecovery.test.withProvider")(function* (
  client: CoreGenerationClient,
  scope: ContentAccessContext,
  run: (provider: NodexYProvider, local: Y.Doc) => Promise<void>,
) {
  const adapter = yield* makeDesktopDocumentSessionHarness(client, scope);
  yield* Effect.promise(async () => {
    const local = new Y.Doc({ guid: documentId });
    const provider = new NodexYProvider({
      documentId,
      document: local,
      adapter,
      autoConnect: false,
      localCheckpointStore: null,
    });
    try {
      await provider.connect();
      await run(provider, local);
    } finally {
      provider.destroy();
      local.destroy();
    }
  });
});

scopes.forEach((scope) =>
  it.live(`preserves a deterministic rejection across the ${scope.kind} Desktop boundary`, () =>
    Effect.gen(function* () {
      const { client, server } = fixture();
      const apply = vi.fn(async () => {
        throw new CoreModuleResponseError({
          code: "invalid_input",
          message: "The document update is invalid",
          retryable: false,
          recovery: { kind: "none" },
        });
      });
      client.documentApplyUpdate = apply;
      try {
        yield* withProvider(client, scope, async (provider, local) => {
          local.getText("title").insert(4, " edited");
          const flushing = provider.flush().catch((error) => error);
          await vi.waitFor(() => expect(provider.getStatus().phase).toBe("error"));
          expect(await flushing).toBeInstanceOf(Error);
          expect(provider.getStatus()).toMatchObject({
            phase: "error",
            error: { code: "invalid_document_update", retryable: false },
            pendingUpdateCount: 1,
          });
          expect(apply).toHaveBeenCalledTimes(1);
        });
      } finally {
        server.destroy();
      }
    }),
  ),
);

it.live("reacquires the physical lease when Core requires a new subscription", () =>
  Effect.gen(function* () {
    const { client, server } = fixture();
    let leaseMissing = false;
    const sync = client.documentSync.bind(client);
    const open = client.openDocumentEventStream.bind(client);
    const openings = vi.fn(async (...args: Parameters<typeof open>) => {
      leaseMissing = false;
      return open(...args);
    });
    client.openDocumentEventStream = openings;
    client.documentSync = async (request) => {
      if (leaseMissing)
        throw new CoreModuleResponseError({
          code: "unauthorized",
          message: "An exact Document subscription is required",
          retryable: true,
          recovery: { kind: "reconnect_document_subscription" },
        });
      return sync(request);
    };
    try {
      yield* withProvider(client, { kind: "library" }, async (provider) => {
        leaseMissing = true;
        await provider.connect();
        await vi.waitFor(() => expect(provider.getStatus().phase).toBe("synced"));
        expect(openings).toHaveBeenCalledTimes(2);
      });
    } finally {
      server.destroy();
    }
  }),
);

it.live("propagates terminal stream failure and settles durable waiters", () =>
  Effect.gen(function* () {
    const { client, server } = fixture();
    const open = client.openDocumentEventStream.bind(client);
    let rejectStream: (error: Error) => void = () => undefined;
    const openings = vi.fn(async (...args: Parameters<typeof open>) => ({
      ...(await open(...args)),
      done: new Promise<void>((_resolve, reject) => {
        rejectStream = reject;
      }),
    }));
    client.openDocumentEventStream = openings;
    try {
      yield* withProvider(client, { kind: "library" }, async (provider) => {
        rejectStream(new CoreEventCompatibilityError("The document stream is incompatible"));
        await vi.waitFor(() => expect(provider.getStatus().phase).toBe("error"));
        expect(provider.getStatus().error).toMatchObject({
          code: "invalid_response",
          retryable: false,
        });
        await expect(provider.flush()).rejects.toThrow();
        expect(openings).toHaveBeenCalledTimes(1);
      });
    } finally {
      server.destroy();
    }
  }),
);

scopes
  .flatMap((scope) => [false, true].map((replace) => ({ scope, replace })))
  .forEach(({ scope, replace }) =>
    it.live(
      `retires ${scope.kind} awareness failures after ${replace ? "replacement" : "closure"}`,
      () => {
        const messages: unknown[] = [];
        return Effect.gen(function* () {
          const { client, server } = fixture();
          const open = client.openDocumentEventStream.bind(client);
          const close = vi.fn();
          const openings = vi.fn(async (...args: Parameters<typeof open>) => {
            const stream = await open(...args);
            return {
              ...stream,
              close: () => {
                close();
                stream.close();
              },
            };
          });
          client.openDocumentEventStream = openings;
          let rejectPublication: (error: Error) => void = () => undefined;
          const publish = vi.fn(
            () =>
              new Promise<{ accepted: true }>((_resolve, reject) => {
                rejectPublication = reject;
              }),
          );
          client.documentPublishAwareness = publish;
          const adapter = yield* makeDesktopDocumentSessionHarness(client, scope);
          try {
            yield* Effect.promise(async () => {
              const request = { documentId, clientSessionId: "closing-session" };
              const release = adapter.subscribe(request, () => undefined);
              let releaseReplacement: (() => void) | undefined;
              try {
                await adapter.sync({ ...request, stateVector: new Uint8Array([0]) });
                const pending = adapter.publishAwareness({
                  ...request,
                  storeEpoch: "epoch:test",
                  generation: 1,
                  update: new Uint8Array([0]),
                });
                await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
                release();
                await vi.waitFor(() => expect(close).toHaveBeenCalled());
                if (replace) {
                  releaseReplacement = adapter.subscribe(request, () => undefined);
                  expect(
                    await adapter.sync({ ...request, stateVector: new Uint8Array([0]) }),
                  ).toMatchObject({ ok: true });
                }
                rejectPublication(
                  new CoreModuleResponseError({
                    code: "unauthorized",
                    message: "An exact Yjs subscription is required",
                    retryable: true,
                    recovery: { kind: "reconnect_document_subscription" },
                  }),
                );
                expect(await pending).toMatchObject({ ok: false });
                expect(openings).toHaveBeenCalledTimes(replace ? 2 : 1);
                expect(
                  messages.filter((message) =>
                    String(message).includes("Document session command failed"),
                  ),
                ).toEqual([]);
              } finally {
                releaseReplacement?.();
                release();
              }
            });
          } finally {
            server.destroy();
          }
        }).pipe(
          Effect.withLogger(
            Logger.make(({ message }) => {
              messages.push(message);
            }),
          ),
        );
      },
    ),
  );

it.live("a retired sync response cannot replace the new session's canonical generation", () =>
  Effect.gen(function* () {
    const { client, server } = fixture();
    const open = client.openDocumentEventStream.bind(client);
    let generation = 0;
    let emit: (event: DocumentSyncRealtimeEvent) => void = () => undefined;
    const closed = vi.fn();
    client.openDocumentEventStream = async (...args: Parameters<typeof open>) => {
      const stream = await open(...args);
      generation += 1;
      emit = args[3];
      return {
        ...stream,
        barrier: { ...stream.barrier, document_generation: generation },
        close: () => {
          closed();
          stream.close();
        },
      };
    };
    let completeOldSync: (response: DocumentSyncResponse) => void = () => undefined;
    const originalSync = client.documentSync.bind(client);
    const oldResponse = yield* Effect.promise(() =>
      originalSync({
        documentId,
        clientSessionId: "reused-session",
        stateVector: new Uint8Array([0]),
      }),
    );
    const sync = vi.fn(async () => {
      if (generation === 1)
        return new Promise<DocumentSyncResponse>((resolve) => {
          completeOldSync = resolve;
        });
      return { ...oldResponse, generation };
    });
    client.documentSync = sync;
    const adapter = yield* makeDesktopDocumentSessionHarness(client, { kind: "library" });
    try {
      yield* Effect.promise(async () => {
        const request = { documentId, clientSessionId: "reused-session" };
        const release = adapter.subscribe(request, () => undefined);
        let releaseReplacement: (() => void) | undefined;
        try {
          const oldSync = adapter.sync({ ...request, stateVector: new Uint8Array([0]) });
          await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
          release();
          await vi.waitFor(() => expect(closed).toHaveBeenCalled());
          const events: DocumentSyncRealtimeEvent[] = [];
          releaseReplacement = adapter.subscribe(request, (event) => events.push(event));
          expect(
            await adapter.sync({ ...request, stateVector: new Uint8Array([0]) }),
          ).toMatchObject({ ok: true, value: { generation: 2 } });
          completeOldSync(oldResponse);
          await oldSync;
          const update = {
            kind: "document-update",
            documentId,
            updateId: "remote-update",
            clientSessionId: "remote-session",
            storeEpoch: "epoch:test",
            generation: 2,
            headSeq: 1,
            update: new Uint8Array([0]),
          } as const;
          emit(update);
          await vi.waitFor(() => expect(events).toContainEqual(update));
          expect(events.some((event) => event.kind === "resync-required")).toBe(false);
        } finally {
          releaseReplacement?.();
          release();
        }
      });
    } finally {
      server.destroy();
    }
  }),
);
