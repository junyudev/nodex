import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioPageSeed,
  type ScenarioSeedPort,
} from "../contracts";

export const LIBRARY_FILES_SCENARIO_ID = "library/files" as const;
export const LIBRARY_FILES_SCENARIO_REVISION = 1 as const;
export const LIBRARY_FILES_PAGE_A_KEY = "sharedImageA" as const;
export const LIBRARY_FILES_PAGE_B_KEY = "sharedImageB" as const;
export const LIBRARY_FILES_SHARED_FILE_KEY = "sharedFile" as const;
export const LIBRARY_FILES_UNUSED_FILE_KEY = "unusedFile" as const;
export const LIBRARY_FILES_HISTORY_KEY = "pageAHistory" as const;

const SHARED_IMAGE_BYTES = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0,
  0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15, 0, 1, 5, 1, 1, 39, 24,
  227, 102, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

const PAGE_DEFINITIONS = [
  {
    key: LIBRARY_FILES_PAGE_A_KEY,
    status: "build" as const,
    title: "Shared image A",
    logicalPath: "assets/shared.png",
  },
  {
    key: LIBRARY_FILES_PAGE_B_KEY,
    status: "review" as const,
    title: "Shared image B",
    logicalPath: "references/shared.png",
  },
] as const;

export interface LibraryFilesScenarioFacts extends ScenarioFacts {
  readonly sharedFileId: string;
  readonly unusedFileId: string;
  readonly pageAPath: string;
  readonly pageBPath: string;
  readonly pageABodyCount: number;
  readonly pageBBodyCount: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const requireLibraryFilesScenarioFacts = (value: unknown): LibraryFilesScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  if (!isRecord(value)) throw new Error("library/files facts are invalid");
  if (
    envelope.scenarioId !== LIBRARY_FILES_SCENARIO_ID ||
    envelope.scenarioRevision !== LIBRARY_FILES_SCENARIO_REVISION ||
    typeof value.sharedFileId !== "string" ||
    typeof value.unusedFileId !== "string" ||
    typeof value.pageAPath !== "string" ||
    typeof value.pageBPath !== "string" ||
    typeof value.pageABodyCount !== "number" ||
    typeof value.pageBBodyCount !== "number"
  ) {
    throw new Error("library/files facts are invalid");
  }
  return value as unknown as LibraryFilesScenarioFacts;
};

const materializeLibraryFiles = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({ name: "Library Files Lab", sources: [workspace] });
  if (!project.defaultDatabaseViewId) {
    throw new Error("library/files Project has no default Database View");
  }

  const pageIdsByKey: Record<string, string> = {};
  const documentIdsByKey: Record<string, string> = {};
  for (const definition of PAGE_DEFINITIONS) {
    const seed: ScenarioPageSeed = {
      key: definition.key,
      pageId: createUuidV7(),
      operationId: createUuidV7(),
      projectId: project.id,
      status: definition.status,
      title: definition.title,
      nfm: "",
    };
    const page = await port.createPage(seed);
    pageIdsByKey[definition.key] = seed.pageId;
    documentIdsByKey[definition.key] = page.documentId;
  }

  const sharedFileId = createUuidV7();
  await port.createLibraryFile({
    operationId: createUuidV7(),
    projectId: project.id,
    fileId: sharedFileId,
    defaultName: "shared.png",
    mimeType: "image/png",
    bytes: SHARED_IMAGE_BYTES,
  });
  const unusedFileId = createUuidV7();
  await port.createLibraryFile({
    operationId: createUuidV7(),
    projectId: project.id,
    fileId: unusedFileId,
    defaultName: "unused-notes.txt",
    mimeType: "text/plain",
    bytes: new TextEncoder().encode("Independent Library File\n"),
  });

  let minimumCommitSeq = 0;
  for (const definition of PAGE_DEFINITIONS) {
    const pageId = pageIdsByKey[definition.key];
    if (!pageId) throw new Error(`library/files Page ${definition.key} is missing`);
    await port.addPageFileEntry({
      operationId: createUuidV7(),
      projectId: project.id,
      pageId,
      fileId: sharedFileId,
      logicalPath: definition.logicalPath,
      expectedManifestRevision: 0,
    });
    const replacement = await port.replaceOwnedDocument({
      mutationId: createUuidV7(),
      operationId: createUuidV7(),
      clientSessionId: `scenario:${LIBRARY_FILES_SCENARIO_ID}`,
      projectId: project.id,
      pageId,
      nfm: `<image source="nodex://files/${sharedFileId}">${definition.title}</image>`,
    });
    minimumCommitSeq = Math.max(minimumCommitSeq, replacement.commitSeq);
  }

  const pageAId = pageIdsByKey[LIBRARY_FILES_PAGE_A_KEY];
  const pageADocumentId = documentIdsByKey[LIBRARY_FILES_PAGE_A_KEY];
  if (!pageAId || !pageADocumentId) throw new Error("library/files Page A is missing");
  const historyVersionId = await port.createDocumentCheckpoint({
    operationId: createUuidV7(),
    projectId: project.id,
    pageId: pageAId,
    documentId: pageADocumentId,
    label: "Shared image v1",
  });

  return {
    version: 1,
    scenarioId: LIBRARY_FILES_SCENARIO_ID,
    scenarioRevision: LIBRARY_FILES_SCENARIO_REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey,
    entityIdsByKey: {
      [LIBRARY_FILES_SHARED_FILE_KEY]: sharedFileId,
      [LIBRARY_FILES_UNUSED_FILE_KEY]: unusedFileId,
      [LIBRARY_FILES_HISTORY_KEY]: historyVersionId,
    },
    minimumCommitSeq,
    materializedAt: new Date().toISOString(),
  };
};

const inspectLibraryFiles = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<LibraryFilesScenarioFacts> => {
  const pageAId = manifest.pageIdsByKey[LIBRARY_FILES_PAGE_A_KEY];
  const pageBId = manifest.pageIdsByKey[LIBRARY_FILES_PAGE_B_KEY];
  const sharedFileId = manifest.entityIdsByKey?.[LIBRARY_FILES_SHARED_FILE_KEY];
  const unusedFileId = manifest.entityIdsByKey?.[LIBRARY_FILES_UNUSED_FILE_KEY];
  if (!pageAId || !pageBId || !sharedFileId || !unusedFileId) {
    throw new Error("library/files manifest is incomplete");
  }
  const [pageA, pageB] = await Promise.all([
    port.readPageFileInventory(manifest.projectId, pageAId),
    port.readPageFileInventory(manifest.projectId, pageBId),
  ]);
  const pageAFile = pageA.files.find((item) => item.file.file_id === sharedFileId);
  const pageBFile = pageB.files.find((item) => item.file.file_id === sharedFileId);
  if (
    pageA.total !== 1 ||
    pageB.total !== 1 ||
    pageAFile?.logical_path !== "assets/shared.png" ||
    pageBFile?.logical_path !== "references/shared.png" ||
    pageAFile.body_count !== 1 ||
    pageBFile.body_count !== 1
  ) {
    throw new Error("library/files relationships do not match the scenario contract");
  }
  return {
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    sharedFileId,
    unusedFileId,
    pageAPath: pageAFile.logical_path,
    pageBPath: pageBFile.logical_path,
    pageABodyCount: pageAFile.body_count,
    pageBBodyCount: pageBFile.body_count,
  };
};

export const libraryFilesScenario: ScenarioDomainRecipe = {
  id: LIBRARY_FILES_SCENARIO_ID,
  revision: LIBRARY_FILES_SCENARIO_REVISION,
  materialize: materializeLibraryFiles,
  inspect: inspectLibraryFiles,
  parseFacts: requireLibraryFilesScenarioFacts,
};
