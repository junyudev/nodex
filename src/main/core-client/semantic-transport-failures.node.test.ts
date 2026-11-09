/* @effect-diagnostics asyncFunction:off -- Tests the Promise boundary between semantic adapters and connection authority. */
import { expect, test, vi } from "vite-plus/test";
import { CoreModuleResponseError } from "./core-client";
import { CoreHttpError, CoreTransportError } from "./local-http";
import { createCoreLibraryModuleAdapter } from "./library-module-adapter";
import { createCoreDatabaseModuleAdapter } from "./database-module-adapter";
import { createCoreCanvasSceneAdapter } from "./core-canvas-scene-adapter";
import { parseDatabaseId } from "../../shared/database-identities";
import { FakeCoreClient } from "./testing/fake-core-client";

const identity = {
  libraryId: "library",
  profileId: "profile",
  storeEpoch: "epoch",
  projectId: "project",
};

test.each([
  new CoreTransportError("connection_lost", "response", "ECONNRESET", null),
  new CoreHttpError(401, "Session expired"),
  new CoreModuleResponseError({
    code: "unauthorized",
    message: "Renew queued session",
    retryable: true,
    recovery: { kind: "renew_remote_session" },
  }),
])("semantic content adapters preserve $name for authority recovery", async (error) => {
  const client = new FakeCoreClient();
  vi.spyOn(client, "libraryRead").mockRejectedValue(error);
  vi.spyOn(client, "libraryApply").mockRejectedValue(error);
  vi.spyOn(client, "databaseRead").mockRejectedValue(error);
  vi.spyOn(client, "databaseApply").mockRejectedValue(error);
  vi.spyOn(client, "documentCanvasSync").mockRejectedValue(error);
  const library = createCoreLibraryModuleAdapter({ client, ...identity });
  const database = createCoreDatabaseModuleAdapter({ client, ...identity });
  const routingContext = { kind: "library" } as const;
  const canvas = createCoreCanvasSceneAdapter(client, { ...identity, routingContext });
  await expect(library.read({ read: { mode: "metadata" } })).rejects.toBe(error);
  await expect(
    library.applyPageLifecycleMutation({
      operationId: "archive",
      projectId: identity.projectId,
      storeEpoch: identity.storeEpoch,
      actor: { kind: "electron_renderer" },
      operation: { kind: "archive_page", pageId: "page", expectedMetadataRevision: 1 },
    }),
  ).rejects.toBe(error);
  await expect(
    database.read({
      projectId: identity.projectId,
      read: { target: { kind: "project_default" }, mode: "database" },
    }),
  ).rejects.toBe(error);
  await expect(
    database.apply({
      operationId: "rename",
      projectId: identity.projectId,
      storeEpoch: identity.storeEpoch,
      actor: {},
      operations: [
        {
          kind: "rename_page_key_prefix",
          databaseId: parseDatabaseId("database"),
          expectedRevision: 1,
          prefix: "OPS",
        },
      ],
    }),
  ).rejects.toBe(error);
  await expect(
    canvas.sync({
      syncRequestId: "sync",
      routingContext,
      documentId: "document",
      clientSessionId: "editor",
    }),
  ).rejects.toBe(error);
});
