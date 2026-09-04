import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Y from "yjs";
import { createPageDocument } from "../../shared/block-documents/page-document";
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
