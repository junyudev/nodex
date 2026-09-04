import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import * as Y from "yjs";
import {
  createIsolatedProfile,
  cleanupIsolatedProfile,
} from "../../../scripts/scenarios/profile/isolated-profile";
import { CoreClientSeedAdapter } from "../../../scripts/scenarios/adapters/core-client-seed-adapter";
import { materializeScenario } from "../../../scripts/scenarios/seed/scenario-seed";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { initializeStandaloneDataAuthority } from "./standalone-data-authority";
import { createCoreDocumentSyncAdapter } from "./document-sync-adapter";
import { createCoreCanvasSceneAdapter } from "./core-canvas-scene-adapter";
import { NodexYProvider } from "../../renderer/lib/nodex-y-provider";
import { CanvasSceneProvider } from "../../renderer/lib/canvas-scene-provider";
import { MemoryCanvasSceneOutbox } from "../../renderer/lib/canvas-scene-outbox";
import { createBoundedOperationId, isBoundedOperationId } from "../../shared/operation-identity";
import type {
  DocumentSyncApplyRequest,
  CanvasSceneMutationRequest,
} from "../../shared/block-documents";

// This historical-storage fixture changes only the cutover clock, while Core is
// stopped. Content still comes from the authoritative public-operation scenario.
test.each(["page", "canvas", "checkpoint"] as const)(
  "%s saves and exact retries remain usable after the legacy identity window closes",
  async (kind) => {
    const profile = await createIsolatedProfile({ label: `aged-document-${kind}`, codex: "empty" });
    const start = () =>
      initializeStandaloneDataAuthority({
        nodexHome: profile.nodexHome,
        isPackaged: false,
        buildId: "document-operation-window",
      });
    let runtime: Awaited<ReturnType<typeof start>> | undefined;
    const stop = async () => {
      if (!runtime) return;
      await runtime.rootClient.shutdown();
      await expect
        .poll(() => existsSync(path.join(profile.nodexHome, "run/core/core.sock")))
        .toBe(false);
      runtime = undefined;
    };
    try {
      runtime = await start();
      const manifest = await materializeScenario(
        DOCUMENT_SYNC_RECOVERY_SCENARIO_ID,
        new CoreClientSeedAdapter(runtime),
        profile.initialProjectsDirectory,
      );
      await stop();
      execFileSync("sqlite3", [
        path.join(profile.nodexHome, "nodex.db"),
        "UPDATE operational_journal_state SET operation_identity_cutover_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 days') WHERE id = 1;",
      ]);
      runtime = await start();
      const client = runtime.clientForProject(manifest.projectId);
      const documents = createCoreDocumentSyncAdapter(client);
      // Prove this fixture would reject an unmigrated producer, not just accept
      // a bounded ID inside the fresh-Profile grace period.
      await expect(
        documents.prepareOwner({
          ownerBlockId: manifest.pageIdsByKey.source!,
          operationId: "legacy-prepare",
          clientSessionId: "legacy-session",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { core: { code: "legacy_idempotency_unavailable" } },
      });

      if (kind === "checkpoint") {
        const descriptor = await documents.readDescriptor({
          ownerBlockId: manifest.pageIdsByKey.source!,
          clientSessionId: "history",
        });
        const request = {
          operationId: createBoundedOperationId("document.checkpoint"),
          projectId: manifest.projectId,
          storeEpoch: client.handshake.store_epoch,
          documentId: descriptor.documentId,
          expectedGeneration: descriptor.generation,
          expectedHeadSeq: descriptor.headSeq,
          cause: "manual",
          actor: { kind: "test" },
        };
        const first = await documents.createCheckpoint(request);
        expect(first).toMatchObject({ ok: true, value: { duplicate: false } });
        const retried = await documents.createCheckpoint(request);
        expect(retried).toMatchObject({ ok: true, value: { duplicate: true } });
        if (!first.ok || !retried.ok) throw new Error("Checkpoint was rejected");
        expect(retried.value.checkpoint.versionId).toBe(first.value.checkpoint.versionId);
        return;
      }

      const documentId =
        manifest.entityIdsByKey?.[kind === "page" ? "sourceDocument" : "canvasDocumentId"];
      if (!documentId) throw new Error("Document scenario omitted its engine identity");
      const clientSessionId = "long-lived-renderer-session";
      const stream = await client.openDocumentEventStream(
        { documentId, clientSessionId },
        () => undefined,
        () => undefined,
        () => undefined,
      );
      try {
        if (kind === "page") {
          const document = new Y.Doc({ guid: documentId });
          const requests: DocumentSyncApplyRequest[] = [];
          const provider = new NodexYProvider({
            documentId,
            document,
            clientSessionId,
            autoConnect: false,
            localCheckpointStore: null,
            adapter: {
              ...documents,
              subscribe: () => () => undefined,
              applyUpdate: async (request) => {
                requests.push(request);
                return documents.applyUpdate(request);
              },
            },
          });
          try {
            await provider.connect();
            document.getText("title").insert(0, "Saved after cutover: ");
            await provider.flush();
            expect(provider.getStatus().phase).toBe("synced");
            expect(requests).toHaveLength(1);
            const request = requests[0]!;
            expect(isBoundedOperationId(request.updateId)).toBe(true);
            await expect(documents.applyUpdate(request)).resolves.toMatchObject({
              ok: true,
              value: { duplicate: true },
            });
            const canonical = new Y.Doc();
            try {
              const synced = await documents.sync({
                documentId,
                clientSessionId,
                stateVector: Y.encodeStateVector(canonical),
              });
              if (!synced.ok) throw new Error(synced.error.message);
              Y.applyUpdate(canonical, synced.value.update);
              expect(canonical.getText("title").toString()).toBe(
                document.getText("title").toString(),
              );
            } finally {
              canonical.destroy();
            }
          } finally {
            provider.destroy();
            document.destroy();
          }
          return;
        }
        const libraryId = runtime.identity.libraryId;
        const accessContext = { kind: "project", projectId: manifest.projectId } as const;
        const adapter = createCoreCanvasSceneAdapter(client, { libraryId, accessContext });
        const requests: CanvasSceneMutationRequest[] = [];
        const provider = new CanvasSceneProvider({
          libraryId,
          accessContext,
          documentId,
          clientSessionId,
          outbox: new MemoryCanvasSceneOutbox(libraryId),
          onScene: () => undefined,
          adapter: {
            ...adapter,
            subscribe: () => () => undefined,
            applyMutation: async (request) => {
              requests.push(request);
              return adapter.applyMutation(request);
            },
          },
        });
        try {
          await provider.connect();
          await provider.submit({
            elementCandidates: [
              {
                id: "test-element",
                type: "text",
                index: "a0",
                version: 1,
                versionNonce: 1,
                isDeleted: false,
                text: "Saved after cutover",
              },
            ],
          });
          expect(provider.getStatus().phase).toBe("ready");
          expect(requests).toHaveLength(1);
          expect(isBoundedOperationId(requests[0]!.mutationId)).toBe(true);
          await expect(adapter.applyMutation(requests[0]!)).resolves.toMatchObject({
            ok: true,
            value: { duplicate: true },
          });
          expect(provider.getScene()?.elements[0]?.text).toBe("Saved after cutover");
        } finally {
          await provider.close();
        }
      } finally {
        stream.close();
      }
    } finally {
      await stop();
      const cleanup = await cleanupIsolatedProfile(profile);
      expect(cleanup.status).not.toBe("unsafe");
    }
  },
);
