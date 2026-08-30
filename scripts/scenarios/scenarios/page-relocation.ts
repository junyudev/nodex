import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const PAGE_RELOCATION_SCENARIO_ID = "library/page-relocation" as const;
export const PAGE_RELOCATION_SCENARIO_REVISION = 1 as const;
export const PAGE_RELOCATION_SOURCE_PAGE_KEY = "sourcePage" as const;
export const PAGE_RELOCATION_TARGET_PAGE_KEY = "targetPage" as const;
export const PAGE_RELOCATION_STANDALONE_PAGE_KEY = "standalonePage" as const;
export const PAGE_RELOCATION_TARGET_PROJECT_KEY = "targetProject" as const;
export const PAGE_RELOCATION_TARGET_VIEW_KEY = "targetView" as const;

export interface PageRelocationScenarioFacts extends ScenarioFacts {
  readonly sourcePageId: string;
  readonly targetPageId: string;
  readonly standalonePageId: string;
  readonly sourceProjectId: string;
  readonly sourceViewId: string;
  readonly sourceRowCount: number;
  readonly targetProjectId: string;
  readonly targetViewId: string;
  readonly targetRowCount: number;
}

export const requirePageRelocationScenarioFacts = (value: unknown): PageRelocationScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  const candidate = value as Record<string, unknown>;
  if (
    envelope.scenarioId !== PAGE_RELOCATION_SCENARIO_ID ||
    envelope.scenarioRevision !== PAGE_RELOCATION_SCENARIO_REVISION ||
    typeof candidate.sourcePageId !== "string" ||
    typeof candidate.targetPageId !== "string" ||
    typeof candidate.standalonePageId !== "string" ||
    typeof candidate.sourceProjectId !== "string" ||
    typeof candidate.sourceViewId !== "string" ||
    candidate.sourceRowCount !== 1 ||
    typeof candidate.targetProjectId !== "string" ||
    typeof candidate.targetViewId !== "string" ||
    candidate.targetRowCount !== 1
  ) {
    throw new Error("library/page-relocation facts are invalid");
  }
  return value as PageRelocationScenarioFacts;
};

const materialize = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const [sourceProject, targetProject] = await Promise.all([
    port.createProject({ name: "Relocation Alpha", sources: [workspace] }),
    port.createProject({ name: "Relocation Beta", sources: [workspace] }),
  ]);
  if (!sourceProject.defaultDatabaseViewId || !targetProject.defaultDatabaseViewId) {
    throw new Error("library/page-relocation requires two default Database Views");
  }
  const sourcePageId = createUuidV7();
  const targetPageId = createUuidV7();
  const standalonePageId = createUuidV7();
  await Promise.all([
    port.createPage({
      key: PAGE_RELOCATION_SOURCE_PAGE_KEY,
      pageId: sourcePageId,
      operationId: createUuidV7(),
      projectId: sourceProject.id,
      status: "build",
      title: "Move this Page",
      nfm: "This content and Page identity must survive relocation and Undo.",
    }),
    port.createPage({
      key: PAGE_RELOCATION_TARGET_PAGE_KEY,
      pageId: targetPageId,
      operationId: createUuidV7(),
      projectId: targetProject.id,
      status: "plan",
      title: "Beta parent Page",
      nfm: "A valid Page destination in the same Library.",
    }),
    port.createStandalonePage({
      pageId: standalonePageId,
      documentId: createUuidV7(),
      operationId: createUuidV7(),
      projectId: sourceProject.id,
      title: "Sidebar Page to move",
    }),
  ]);
  return {
    version: 1,
    scenarioId: PAGE_RELOCATION_SCENARIO_ID,
    scenarioRevision: PAGE_RELOCATION_SCENARIO_REVISION,
    projectId: sourceProject.id,
    databaseViewId: sourceProject.defaultDatabaseViewId,
    pageIdsByKey: {
      [PAGE_RELOCATION_SOURCE_PAGE_KEY]: sourcePageId,
      [PAGE_RELOCATION_TARGET_PAGE_KEY]: targetPageId,
      [PAGE_RELOCATION_STANDALONE_PAGE_KEY]: standalonePageId,
    },
    entityIdsByKey: {
      [PAGE_RELOCATION_TARGET_PROJECT_KEY]: targetProject.id,
      [PAGE_RELOCATION_TARGET_VIEW_KEY]: targetProject.defaultDatabaseViewId,
    },
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
};

const inspect = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<PageRelocationScenarioFacts> => {
  const sourcePageId = manifest.pageIdsByKey[PAGE_RELOCATION_SOURCE_PAGE_KEY];
  const targetPageId = manifest.pageIdsByKey[PAGE_RELOCATION_TARGET_PAGE_KEY];
  const standalonePageId = manifest.pageIdsByKey[PAGE_RELOCATION_STANDALONE_PAGE_KEY];
  const targetProjectId = manifest.entityIdsByKey?.[PAGE_RELOCATION_TARGET_PROJECT_KEY];
  const targetViewId = manifest.entityIdsByKey?.[PAGE_RELOCATION_TARGET_VIEW_KEY];
  if (!sourcePageId || !targetPageId || !standalonePageId || !targetProjectId || !targetViewId) {
    throw new Error("library/page-relocation manifest is incomplete");
  }
  const [sourceBoard, targetBoard] = await Promise.all([
    port.readBoard(manifest.projectId, manifest.databaseViewId),
    port.readBoard(targetProjectId, targetViewId),
  ]);
  return requirePageRelocationScenarioFacts({
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    sourcePageId,
    targetPageId,
    standalonePageId,
    sourceProjectId: manifest.projectId,
    sourceViewId: manifest.databaseViewId,
    sourceRowCount: sourceBoard.totalRows,
    targetProjectId,
    targetViewId,
    targetRowCount: targetBoard.totalRows,
  });
};

export const pageRelocationScenario: ScenarioDomainRecipe = {
  id: PAGE_RELOCATION_SCENARIO_ID,
  revision: PAGE_RELOCATION_SCENARIO_REVISION,
  materialize,
  inspect,
  parseFacts: requirePageRelocationScenarioFacts,
};
