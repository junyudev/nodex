import { createUuidV7 } from "../../../src/shared/uuid-v7";
import { parseScenarioFacts, type ScenarioDomainRecipe, type ScenarioManifest } from "../contracts";

export const DOCUMENT_SYNC_RECOVERY_SCENARIO_ID = "document-sync-recovery";
const parseFacts: ScenarioDomainRecipe["parseFacts"] = (value) => {
  const facts = parseScenarioFacts(value);
  if (facts.scenarioId !== DOCUMENT_SYNC_RECOVERY_SCENARIO_ID || facts.scenarioRevision !== 1)
    throw new Error("Invalid document recovery scenario facts");
  return facts;
};

export const documentSyncRecoveryScenario: ScenarioDomainRecipe = {
  id: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID,
  revision: 1,
  parseFacts,
  async materialize(port, workspace): Promise<ScenarioManifest> {
    const project = await port.createProject({ name: "Document Recovery", sources: [workspace] });
    if (!project.defaultDatabaseViewId)
      throw new Error("Document recovery requires a Database View");
    const source = createUuidV7();
    const other = createUuidV7();
    const child = createUuidV7();
    const canvasId = createUuidV7();
    const canvasDocumentId = createUuidV7();
    const sourceDocument = await port.createPage({
      key: "source",
      pageId: source,
      projectId: project.id,
      operationId: createUuidV7(),
      status: "build",
      title: "Edit and recover",
      nfm: "First paragraph\n\nSecond paragraph\n\nLast paragraph",
    });
    const otherDocument = await port.createPage({
      key: "other",
      pageId: other,
      projectId: project.id,
      operationId: createUuidV7(),
      status: "build",
      title: "Independent page",
      nfm: "This document remains independent.",
    });
    const body = await port.replaceOwnedDocument({
      projectId: project.id,
      pageId: source,
      mutationId: createUuidV7(),
      operationId: createUuidV7(),
      clientSessionId: createUuidV7(),
      nfm: "First paragraph\nSecond paragraph\nLast paragraph",
    });
    const lastBlockId = body.createdBlockIds[2];
    if (!lastBlockId) throw new Error("Recovery scenario needs three paragraph identities");
    await port.createStandalonePage({
      pageId: child,
      documentId: createUuidV7(),
      projectId: project.id,
      operationId: createUuidV7(),
      title: "Owned child",
      parentPageId: source,
      beforeBlockId: lastBlockId,
    });
    await port.createStandaloneCanvas({
      projectId: project.id,
      canvasId,
      documentId: canvasDocumentId,
      name: "Recovery canvas",
    });
    return {
      version: 1,
      scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID,
      scenarioRevision: 1,
      projectId: project.id,
      databaseViewId: project.defaultDatabaseViewId,
      pageIdsByKey: { source, other, child },
      entityIdsByKey: {
        sourceDocument: sourceDocument.documentId,
        otherDocument: otherDocument.documentId,
        canvasId,
        canvasDocumentId,
      },
      minimumCommitSeq: 0,
      materializedAt: new Date().toISOString(),
    };
  },
  async inspect(port, manifest) {
    const source = await port.readPage(manifest.projectId, manifest.pageIdsByKey.source!);
    const other = await port.readPage(manifest.projectId, manifest.pageIdsByKey.other!);
    if (source.documentReadiness !== "ready" || other.documentReadiness !== "ready")
      throw new Error("Recovery scenario documents are not ready");
    return {
      scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID,
      scenarioRevision: 1,
      sourcePageId: source.pageId,
      otherPageId: other.pageId,
    };
  },
};
