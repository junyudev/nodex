import { describe, expect, test } from "vite-plus/test";

import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  LIBRARY_FILES_HISTORY_KEY,
  LIBRARY_FILES_PAGE_A_KEY,
  LIBRARY_FILES_PAGE_B_KEY,
  LIBRARY_FILES_SCENARIO_ID,
  requireLibraryFilesScenarioFacts,
} from "../../../scripts/scenarios/scenarios/library-files";
import { createUuidV7 } from "../../shared/uuid-v7";
import { createCoreLibraryModuleAdapter } from "./library-module-adapter";
import { createCoreDocumentSyncAdapter } from "./document-sync-adapter";

describe("library/files authoritative scenario", () => {
  test("materializes one independent File and one exact File shared by two Pages", async () => {
    await withCoreScenario({ scenarioId: LIBRARY_FILES_SCENARIO_ID }, async (context) => {
      const identity = await context.client.libraryRead({ kind: "local_member" });
      if (identity.value.kind !== "local_member") throw new Error("Member identity required");
      const memberId = identity.value.value.id;
      const facts = requireLibraryFilesScenarioFacts(context.facts);
      expect(facts).toMatchObject({
        pageAPath: "assets/shared.png",
        pageBPath: "references/shared.png",
        pageABodyCount: 1,
        pageBBodyCount: 1,
      });
      expect(facts.sharedFileId).not.toBe(facts.unusedFileId);

      const inventory = await context.seed.readPageFileInventory(
        context.manifest.projectId,
        context.manifest.pageIdsByKey[LIBRARY_FILES_PAGE_A_KEY]!,
      );
      const shared = inventory.files.find((item) => item.file.file_id === facts.sharedFileId);
      expect(shared?.attachment?.attached_by).toEqual({ type: "member", member_id: memberId });
      expect(shared?.attachment?.attached_at).toEqual(expect.any(String));
      expect(Number.isFinite(Date.parse(shared!.attachment!.attached_at!))).toBe(true);

      const project = context.runtime.clientForProject(context.manifest.projectId);
      const [pageABytes, pageBBytes, unusedBytes] = await Promise.all([
        project.readFileBlob({
          fileId: facts.sharedFileId,
          source: {
            kind: "page",
            page_id: context.manifest.pageIdsByKey[LIBRARY_FILES_PAGE_A_KEY]!,
          },
        }),
        project.readFileBlob({
          fileId: facts.sharedFileId,
          source: {
            kind: "page",
            page_id: context.manifest.pageIdsByKey[LIBRARY_FILES_PAGE_B_KEY]!,
          },
        }),
        project.readFileBlob({
          fileId: facts.unusedFileId,
          source: { kind: "direct" },
          version: 1,
        }),
      ]);
      expect(pageABytes.etag).toBe(pageBBytes.etag);
      expect(pageABytes.bytes).toEqual(pageBBytes.bytes);
      expect(new TextDecoder().decode(unusedBytes.bytes)).toBe("Independent Library File\n");

      const pageAId = context.manifest.pageIdsByKey[LIBRARY_FILES_PAGE_A_KEY];
      const historyVersionId = context.manifest.entityIdsByKey?.[LIBRARY_FILES_HISTORY_KEY];
      if (!pageAId || !historyVersionId) throw new Error("Scenario history identity is missing");
      const documents = createCoreDocumentSyncAdapter(context.client);
      const descriptor = await documents.readDescriptor({
        ownerBlockId: pageAId,
        clientSessionId: "scenario:verify-history",
      });
      const history = await documents.getVersion({
        projectId: null,
        documentId: descriptor.documentId,
        versionId: historyVersionId,
      });
      expect(history).toMatchObject({
        ok: true,
        value: {
          summary: { fileSnapshotStatus: "exact" },
          materialization: { kind: "page" },
        },
      });
      const { handshake } = context.client;
      const library = createCoreLibraryModuleAdapter({
        client: context.client,
        libraryId: handshake.library_id,
        profileId: handshake.generation.profile_id,
        storeEpoch: handshake.store_epoch,
      });
      expect(await library.listPageHistory({ pageId: pageAId })).toMatchObject({
        ok: true,
        value: {
          documentId: descriptor.documentId,
          entries: expect.arrayContaining([
            expect.objectContaining({
              versionMetadata: expect.objectContaining({ versionId: historyVersionId }),
            }),
          ]),
        },
      });
      const historicalFile = await context.client.readFileBlob({
        fileId: facts.sharedFileId,
        source: {
          kind: "document_revision",
          document_id: descriptor.documentId,
          revision_id: historyVersionId,
        },
      });
      expect(historicalFile.bytes).toEqual(pageABytes.bytes);

      const changed = await createCoreDocumentSyncAdapter(project).applyDocumentMutation({
        mutationId: createUuidV7(),
        projectId: context.manifest.projectId,
        storeEpoch: descriptor.storeEpoch,
        documentId: descriptor.documentId,
        generation: descriptor.generation,
        expectedHeadSeq: descriptor.headSeq,
        markdown: "Current edit",
        actor: { kind: "user" },
      });
      if (!changed.ok) throw new Error(changed.error.message);
      const restore = {
        mutationId: createUuidV7(),
        projectId: null,
        storeEpoch: descriptor.storeEpoch,
        documentId: descriptor.documentId,
        versionId: historyVersionId,
        generation: descriptor.generation,
        expectedHeadSeq: changed.value.headSeq,
        actor: { kind: "user" },
      };
      expect(await documents.restoreVersion(restore)).toMatchObject({
        ok: true,
        value: { projectId: null, headSeq: changed.value.headSeq + 1, duplicate: false },
      });
      expect(await documents.restoreVersion(restore)).toMatchObject({
        ok: true,
        value: { headSeq: changed.value.headSeq + 1, duplicate: true },
      });
      const restored = await library.listPageHistory({ pageId: pageAId });
      if (!restored.ok) throw new Error(restored.error.message);
      const revision = restored.value.entries.find(
        (entry) =>
          entry.kind === "document_version" && entry.versionMetadata.revisionKind === "restore",
      );
      if (!revision || revision.kind !== "document_version")
        throw new Error("Expected restored revision");
      expect(
        await documents.getVersion({
          projectId: null,
          documentId: descriptor.documentId,
          versionId: revision.versionMetadata.versionId,
        }),
      ).toMatchObject({
        ok: true,
        value: { summary: { projectId: null, fileSnapshotStatus: "exact" } },
      });
    });
  });
});
