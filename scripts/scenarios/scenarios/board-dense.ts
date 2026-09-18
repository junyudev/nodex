import { createUuidV7 } from "../../../src/shared/uuid-v7";
import { parseDatabaseViewId } from "../../../src/shared/database-identities";
import type { WorkflowStatus } from "../../../src/shared/workflow-status";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioPageSeed,
  type ScenarioSeedPort,
} from "../contracts";

export const BOARD_DENSE_SCENARIO_ID = "board/dense" as const;
export const BOARD_DENSE_SCENARIO_REVISION = 3 as const;
export const BOARD_DENSE_PRIMARY_PAGE_KEY = "primaryBuildPage" as const;

export interface BoardDenseScenarioFacts extends ScenarioFacts {
  readonly totalRows: number;
  readonly groups: Readonly<Record<WorkflowStatus, number>>;
  readonly listViewId: string;
  readonly primaryBuildPage: {
    readonly pageId: string;
    readonly title: string;
    readonly descriptionPreview: string;
    readonly documentReadiness: "pending_genesis" | "ready" | "failed";
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const requireBoardDenseScenarioFacts = (value: unknown): BoardDenseScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  const candidate = value as Record<string, unknown>;
  const primary = candidate.primaryBuildPage;
  const groups = candidate.groups;
  if (
    typeof candidate.totalRows !== "number" ||
    candidate.totalRows < 0 ||
    !isRecord(groups) ||
    !["triage", "plan", "build", "review", "ship"].every(
      (status) => typeof groups[status] === "number" && groups[status] >= 0,
    ) ||
    typeof candidate.listViewId !== "string" ||
    !isRecord(primary) ||
    typeof primary.pageId !== "string" ||
    typeof primary.title !== "string" ||
    typeof primary.descriptionPreview !== "string" ||
    !["pending_genesis", "ready", "failed"].includes(String(primary.documentReadiness))
  ) {
    throw new Error("board/dense facts are invalid");
  }
  if (
    envelope.scenarioId !== BOARD_DENSE_SCENARIO_ID ||
    envelope.scenarioRevision !== BOARD_DENSE_SCENARIO_REVISION
  ) {
    throw new Error("board/dense facts identity is invalid");
  }
  return value as BoardDenseScenarioFacts;
};

interface BoardDensePageDefinition {
  readonly key: string;
  readonly status: WorkflowStatus;
  readonly title: string;
  readonly nfm: string;
  readonly replaceAfterCreate?: string;
}

const retryIdempotentOperation = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
  try {
    return await operation();
  } catch {
    return await operation();
  }
};

const createListView = async (
  port: ScenarioSeedPort,
  projectId: string,
): Promise<{ readonly viewId: string; readonly commitSeq: number }> => {
  const databaseRead = await port.readDatabase({
    projectId,
    read: { target: { kind: "project_default" }, mode: "database" },
  });
  if (!databaseRead.ok) throw new Error(databaseRead.error.message);
  const databaseSnapshot = databaseRead.value;
  if (databaseSnapshot.value.kind !== "database") {
    throw new Error("board/dense default Database descriptor is unavailable");
  }
  const board = databaseSnapshot.value.value.views.find((view) => view.isDefault);
  if (!board) throw new Error("board/dense default Board View is unavailable");
  const viewId = parseDatabaseViewId(createUuidV7());
  const apply = async (
    operations: Parameters<ScenarioSeedPort["applyDatabase"]>[0]["operations"],
  ) => {
    const result = await port.applyDatabase({
      operationId: createUuidV7(),
      projectId,
      storeEpoch: databaseSnapshot.storeEpoch,
      actor: { kind: "scenario_seed" },
      operations,
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  await apply([
    {
      kind: "duplicate_view",
      databaseId: board.databaseId,
      sourceViewId: board.viewId,
      expectedRevision: board.revision,
      newViewId: viewId,
    },
  ]);
  await apply([
    {
      kind: "change_view_layout",
      databaseId: board.databaseId,
      viewId,
      expectedRevision: 1,
      layout: "list",
    },
  ]);
  const listRead = await port.readDatabase({
    projectId,
    read: { target: { kind: "view", viewId }, mode: "view" },
  });
  if (!listRead.ok) throw new Error(listRead.error.message);
  if (listRead.value.value.kind !== "view") {
    throw new Error("board/dense List View descriptor is unavailable");
  }
  const list = listRead.value.value.value;
  const renamed = await apply([
    {
      kind: "put_view",
      databaseId: list.databaseId,
      dataSourceId: list.dataSourceId,
      viewId: list.viewId,
      expectedRevision: list.revision,
      name: "List",
      layout: "list",
      config: list.config,
      isDefault: false,
    },
  ]);
  return { viewId, commitSeq: renamed.commitSeq };
};

export const BOARD_DENSE_PAGES: readonly BoardDensePageDefinition[] = [
  {
    key: "offlineRecovery",
    status: "triage",
    title: "Clarify offline recovery copy",
    nfm: "Explain how recovery behaves while the network is unavailable.",
  },
  {
    key: "wrappingTitle",
    status: "triage",
    title: "A deliberately long Page title that wraps without hiding the card actions",
    nfm: "Keep the actions reachable at every supported card width.",
  },
  { key: "emptyBrief", status: "triage", title: "Empty brief", nfm: "" },
  {
    key: "sceneOwnership",
    status: "plan",
    title: "Map Project Scene ownership",
    nfm: "# Scene ownership\n\n- Window session owns tabs\n- Core owns durable Pages\n\nKeep the boundary explicit.",
  },
  {
    key: "keyboardPaths",
    status: "plan",
    title: "Review keyboard paths",
    nfm: "Review navigation, focus, and escape behavior.",
  },
  {
    key: BOARD_DENSE_PRIMARY_PAGE_KEY,
    status: "build",
    title: "Unify Database View rendering",
    nfm: "",
    replaceAfterCreate:
      "# Rendering contract\n\n- Use the authoritative Database projection\n- Preserve canonical Page identity\n\nKeep Board and Page views convergent.",
  },
  {
    key: "boundedProjection",
    status: "build",
    title: "Keep projection updates bounded",
    nfm: "A deliberately longer preview explains that local commits should update only the affected projection window while preserving causal coverage.",
  },
  {
    key: "localFirstIdentity",
    status: "build",
    title: "Preserve local-first identity",
    nfm: "Canonical identifiers remain stable across every projection.",
  },
  {
    key: "electronGeometry",
    status: "review",
    title: "Verify real Electron geometry",
    nfm: "Exercise the actual desktop boundary at the canonical viewport.",
  },
  {
    key: "isolatedWorkflow",
    status: "ship",
    title: "Ship the isolated UI workflow",
    nfm: "The same recipe now serves Core, Electron, and seeded development homes.",
  },
] as const;

const materializeBoardDense = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({
    name: "Dense Board",
    sources: [workspace],
  });
  const seeds: readonly ScenarioPageSeed[] = BOARD_DENSE_PAGES.map((page) => ({
    ...page,
    pageId: createUuidV7(),
    operationId: createUuidV7(),
    projectId: project.id,
  }));
  const pageIdsByKey: Record<string, string> = {};
  for (const seed of seeds) {
    await retryIdempotentOperation(() => port.createPage(seed));
    pageIdsByKey[seed.key] = seed.pageId;
  }
  const primaryDefinition = BOARD_DENSE_PAGES.find(
    (page) => page.key === BOARD_DENSE_PRIMARY_PAGE_KEY,
  );
  const primary = seeds.find((page) => page.key === BOARD_DENSE_PRIMARY_PAGE_KEY);
  if (!primary || !primaryDefinition?.replaceAfterCreate) {
    throw new Error("board/dense primary Page definition is missing");
  }
  const referenceTargetPageId = pageIdsByKey.boundedProjection;
  if (!referenceTargetPageId) {
    throw new Error("board/dense reference target Page is missing");
  }
  const replacementIntent = {
    mutationId: createUuidV7(),
    operationId: createUuidV7(),
    clientSessionId: `scenario:${BOARD_DENSE_SCENARIO_ID}`,
    projectId: project.id,
    pageId: primary.pageId,
    nfm: [
      primaryDefinition.replaceAfterCreate,
      "",
      `Related Page: <mention-page url="nodex://pages/${referenceTargetPageId}" />`,
      "",
      `[Open projection notes](nodex://pages/${referenceTargetPageId})`,
      "",
      `<page-ref url="nodex://pages/${referenceTargetPageId}" />`,
    ].join("\n"),
  } as const;
  const replacement = await retryIdempotentOperation(() =>
    port.replaceOwnedDocument(replacementIntent),
  );
  if (!project.defaultDatabaseViewId) {
    throw new Error("board/dense Project has no default Database View");
  }
  const listView = await createListView(port, project.id);
  return {
    version: 1,
    scenarioId: BOARD_DENSE_SCENARIO_ID,
    scenarioRevision: BOARD_DENSE_SCENARIO_REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey,
    entityIdsByKey: { listView: listView.viewId },
    minimumCommitSeq: Math.max(replacement.commitSeq, listView.commitSeq),
    materializedAt: new Date().toISOString(),
  };
};

const inspectBoardDense = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<BoardDenseScenarioFacts> => {
  const primaryPageId = manifest.pageIdsByKey[BOARD_DENSE_PRIMARY_PAGE_KEY];
  if (!primaryPageId) throw new Error("board/dense manifest has no primary Page");
  const listViewId = manifest.entityIdsByKey?.listView;
  if (!listViewId) throw new Error("board/dense manifest has no List View");
  const board = await port.readBoard(
    manifest.projectId,
    manifest.databaseViewId,
    manifest.minimumCommitSeq,
  );
  const primary = await port.readPage(manifest.projectId, primaryPageId, manifest.minimumCommitSeq);
  const facts: BoardDenseScenarioFacts = {
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    totalRows: board.totalRows,
    groups: board.groups,
    listViewId,
    primaryBuildPage: {
      pageId: primary.pageId,
      title: primary.title,
      descriptionPreview: primary.descriptionPreview,
      documentReadiness: primary.documentReadiness,
    },
  };
  if (
    facts.totalRows !== BOARD_DENSE_PAGES.length ||
    facts.groups.triage !== 3 ||
    facts.groups.plan !== 2 ||
    facts.groups.build !== 3 ||
    facts.groups.review !== 1 ||
    facts.groups.ship !== 1 ||
    facts.listViewId !== listViewId ||
    facts.primaryBuildPage.title !== "Unify Database View rendering" ||
    facts.primaryBuildPage.documentReadiness !== "ready"
  ) {
    throw new Error(
      `board/dense materialized facts do not match revision ${BOARD_DENSE_SCENARIO_REVISION}`,
    );
  }
  return facts;
};

export const boardDenseScenario: ScenarioDomainRecipe = {
  id: BOARD_DENSE_SCENARIO_ID,
  revision: BOARD_DENSE_SCENARIO_REVISION,
  materialize: materializeBoardDense,
  inspect: inspectBoardDense,
  parseFacts: requireBoardDenseScenarioFacts,
};
