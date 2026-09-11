import { parseDatabaseViewId } from "../../../src/shared/database-identities";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const STRUCTURAL_INTERACTIONS_SCENARIO_ID = "library/structural-interactions";
export const STRUCTURAL_INTERACTIONS_PRESSURE_SCENARIO_ID =
  "library/structural-interactions-pressure";
const REVISION = 1;
const IMAGE_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAMAAAABgCAIAAADEouq+AAABBklEQVR4nO3SQQkAIADAQMMaxzgGtIN7iHBwAfbYmGvDtfG8gK8ZiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEcgBRsybr72+iHwAAAABJRU5ErkJggg==",
    "base64",
  ),
);

export interface StructuralInteractionsFacts extends ScenarioFacts {
  readonly sourcePageId: string;
  readonly targetPageId: string;
  readonly sharedFileId: string;
  readonly secondFileId: string;
  readonly sourceDocumentId: string;
  readonly paragraphRootId: string;
  readonly imageRootId: string;
  readonly embeddedPageId: string;
  readonly listViewId: string;
}
export const requireStructuralInteractionsFacts = (value: unknown): StructuralInteractionsFacts => {
  const parsed = parseScenarioFacts(value);
  const fields = value as Record<string, unknown>;
  if (
    ![STRUCTURAL_INTERACTIONS_SCENARIO_ID, STRUCTURAL_INTERACTIONS_PRESSURE_SCENARIO_ID].includes(
      parsed.scenarioId,
    ) ||
    parsed.scenarioRevision !== REVISION ||
    [
      "sourcePageId",
      "targetPageId",
      "sharedFileId",
      "secondFileId",
      "sourceDocumentId",
      "paragraphRootId",
      "imageRootId",
      "embeddedPageId",
      "listViewId",
    ].some((key) => typeof fields[key] !== "string" || !fields[key])
  )
    throw new Error("Structural interactions facts are invalid");
  return value as StructuralInteractionsFacts;
};

const materialize = async (
  port: ScenarioSeedPort,
  workspace: string,
  pressure = false,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({
    name: "Structural Interactions",
    sources: [workspace],
  });
  if (!project.defaultDatabaseViewId) throw new Error("Structural interactions requires a Board");
  const sourcePageId = createUuidV7();
  const targetPageId = createUuidV7();
  const source = await port.createPage({
    key: "source",
    pageId: sourcePageId,
    operationId: createUuidV7(),
    projectId: project.id,
    status: "triage",
    title: "Structural source",
    nfm: "",
  });
  await port.createPage({
    key: "target",
    pageId: targetPageId,
    operationId: createUuidV7(),
    projectId: project.id,
    status: "build",
    title: "Paste target",
    nfm: "Paste here",
  });
  const sharedFileId = createUuidV7();
  const secondFileId = createUuidV7();
  for (const [fileId, suffix] of [
    [sharedFileId, 1],
    [secondFileId, 2],
  ] as const)
    await port.createLibraryFile({
      projectId: project.id,
      operationId: createUuidV7(),
      fileId,
      defaultName: `picture-${suffix}.png`,
      mimeType: "image/png",
      bytes: new Uint8Array([...IMAGE_BYTES, suffix]),
    });
  const pressureLines = pressure
    ? [
        ...Array.from(
          { length: 256 },
          (_, index) =>
            `	Pressure paragraph ${index + 1}: retained File references stay attached to their source Page.`,
        ),
        ...Array.from(
          { length: 12 },
          (_, index) =>
            `	<image source="nodex://files/${sharedFileId}">Repeated pressure picture ${index + 1}</image>`,
        ),
      ]
    : [];
  const replaced = await port.replaceOwnedDocument({
    projectId: project.id,
    pageId: sourcePageId,
    mutationId: createUuidV7(),
    operationId: createUuidV7(),
    clientSessionId: "scenario:structural-interactions",
    nfm: [
      "Before source",
      "1XL Structural batch",
      `\t<image source="nodex://files/${sharedFileId}">Repeated picture</image>`,
      `\t<image source="nodex://files/${sharedFileId}">Repeated picture again</image>`,
      `\t<image source="nodex://files/${secondFileId}">Second picture</image>`,
      `\tReference [picture](nodex://files/${sharedFileId})`,
      ...pressureLines,
      `\tChild text remains editable`,
      `<image source="nodex://files/${sharedFileId}">Standalone picture</image>`,
      "After source",
    ].join("\n"),
  });
  const paragraphRootId = replaced.createdBlockIds[1];
  const imageRootId = replaced.createdBlockIds[7 + pressureLines.length];
  if (!paragraphRootId || !imageRootId) throw new Error("Structural fixture omitted its roots");
  const embeddedPageId = createUuidV7();
  await port.createStandalonePage({
    projectId: project.id,
    parentPageId: sourcePageId,
    pageId: embeddedPageId,
    documentId: createUuidV7(),
    operationId: createUuidV7(),
    title: "Embedded Page",
  });
  const readOnlyPageId = createUuidV7();
  await port.createStandalonePage({
    projectId: project.id,
    pageId: readOnlyPageId,
    documentId: createUuidV7(),
    operationId: createUuidV7(),
    title: "Read-only source",
  });
  await port.setResourceProjectAccess({
    projectId: project.id,
    target: { kind: "page", pageId: readOnlyPageId },
    access: "read",
  });
  for (const fileId of [sharedFileId, secondFileId])
    await port.setResourceProjectAccess({
      projectId: project.id,
      target: { kind: "file", fileId },
      access: null,
    });
  const board = await port.readDatabase({
    projectId: project.id,
    read: {
      target: { kind: "view", viewId: parseDatabaseViewId(project.defaultDatabaseViewId) },
      mode: "view",
    },
  });
  if (!board.ok || board.value.value.kind !== "view")
    throw new Error("Structural fixture Board read failed");
  const view = board.value.value.value;
  const listViewId = parseDatabaseViewId(createUuidV7());
  const created = await port.applyDatabase({
    projectId: project.id,
    storeEpoch: board.value.storeEpoch,
    operationId: createUuidV7(),
    actor: { kind: "scenario" },
    operations: [
      {
        kind: "duplicate_view",
        databaseId: view.databaseId,
        sourceViewId: view.viewId,
        expectedRevision: view.revision,
        newViewId: listViewId,
      },
      {
        kind: "change_view_layout",
        databaseId: view.databaseId,
        viewId: listViewId,
        expectedRevision: 1,
        layout: "list",
      },
    ],
  });
  if (!created.ok) throw new Error("Structural fixture List creation failed");
  return {
    version: 1,
    scenarioId: pressure
      ? STRUCTURAL_INTERACTIONS_PRESSURE_SCENARIO_ID
      : STRUCTURAL_INTERACTIONS_SCENARIO_ID,
    scenarioRevision: REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey: {
      source: sourcePageId,
      target: targetPageId,
      embedded: embeddedPageId,
      readOnly: readOnlyPageId,
    },
    entityIdsByKey: {
      sharedFileId,
      secondFileId,
      paragraphRootId,
      imageRootId,
      sourceDocumentId: source.documentId,
      listViewId,
    },
    minimumCommitSeq: replaced.commitSeq,
    materializedAt: new Date().toISOString(),
  };
};

const inspect = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<StructuralInteractionsFacts> => {
  const facts = requireStructuralInteractionsFacts({
    ...manifest.entityIdsByKey,
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    sourcePageId: manifest.pageIdsByKey.source,
    targetPageId: manifest.pageIdsByKey.target,
    embeddedPageId: manifest.pageIdsByKey.embedded,
  });
  const inventory = await port.readPageFileInventory(manifest.projectId, facts.sourcePageId);
  if (
    !inventory.files.some(
      (entry) => entry.file.file_id === facts.sharedFileId && entry.body_count >= 3,
    ) ||
    !inventory.files.some(
      (entry) => entry.file.file_id === facts.secondFileId && entry.body_count === 1,
    )
  )
    throw new Error("Structural fixture must expose body-only File relationships");
  return facts;
};

export const structuralInteractionsScenario: ScenarioDomainRecipe = {
  id: STRUCTURAL_INTERACTIONS_SCENARIO_ID,
  revision: REVISION,
  materialize,
  inspect,
  parseFacts: requireStructuralInteractionsFacts,
};

/** Larger public-operation fixture; correctness keeps the smaller authoritative scenario. */
export const structuralInteractionsPressureScenario: ScenarioDomainRecipe = {
  id: STRUCTURAL_INTERACTIONS_PRESSURE_SCENARIO_ID,
  revision: REVISION,
  materialize: (port, workspace) => materialize(port, workspace, true),
  inspect,
  parseFacts: requireStructuralInteractionsFacts,
};
