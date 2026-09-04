import { describe, expect, test } from "vite-plus/test";

import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  LIBRARY_FILES_HISTORY_KEY,
  LIBRARY_FILES_PAGE_A_KEY,
  LIBRARY_FILES_PAGE_B_KEY,
  LIBRARY_FILES_SCENARIO_ID,
  requireLibraryFilesScenarioFacts,
} from "../../../scripts/scenarios/scenarios/library-files";
import { createCoreDocumentSyncAdapter } from "./document-sync-adapter";

describe("library/files authoritative scenario", () => {
  test("materializes one independent File and one exact File shared by two Pages", async () => {
    await withCoreScenario({ scenarioId: LIBRARY_FILES_SCENARIO_ID }, async (context) => {
      const facts = requireLibraryFilesScenarioFacts(context.facts);
      expect(facts).toMatchObject({
        pageAPath: "assets/shared.png",
        pageBPath: "references/shared.png",
        pageABodyCount: 1,
        pageBBodyCount: 1,
      });
      expect(facts.sharedFileId).not.toBe(facts.unusedFileId);

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
      const documents = createCoreDocumentSyncAdapter(project);
      const descriptor = await documents.readDescriptor({
        ownerBlockId: pageAId,
        clientSessionId: "scenario:verify-history",
      });
      const history = await documents.getVersion({
        projectId: context.manifest.projectId,
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
    });
  });
});
