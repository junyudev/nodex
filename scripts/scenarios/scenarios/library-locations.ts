import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
} from "../../../src/shared/database-identities";
import type { PageParent } from "../../../src/shared/page";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const LIBRARY_LOCATIONS_SCENARIO_ID = "library/locations" as const;
export const LIBRARY_LOCATIONS_SCENARIO_REVISION = 1 as const;

const titles = {
  launchPlan: "Launch plan",
  risks: "Risks",
  roadmap: "Q4 roadmap",
  milestones: "Milestones",
  research: "Research DB",
  interview: "Interview notes",
  chat: "Plan the launch",
} as const;

const idKeys = [
  "atlasProjectId",
  "beaconProjectId",
  "atlasDatabaseId",
  "atlasDatabaseViewId",
  "researchDatabaseId",
  "atlasLaunchPlanId",
  "atlasRisksId",
  "beaconLaunchPlanId",
  "q4RoadmapId",
  "milestonesId",
  "interviewNotesId",
  "atlasChatSessionId",
] as const;

export type LibraryLocationsScenarioFacts = ScenarioFacts &
  Readonly<Record<(typeof idKeys)[number], string>>;

export const requireLibraryLocationsScenarioFacts = (
  value: unknown,
): LibraryLocationsScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  const fields = value as Record<string, unknown>;
  if (
    envelope.scenarioId !== LIBRARY_LOCATIONS_SCENARIO_ID ||
    envelope.scenarioRevision !== LIBRARY_LOCATIONS_SCENARIO_REVISION ||
    idKeys.some((key) => typeof fields[key] !== "string" || !fields[key])
  ) {
    throw new Error("library/locations facts are invalid");
  }
  return value as LibraryLocationsScenarioFacts;
};

const readDatabase = async (port: ScenarioSeedPort, projectId: string, databaseId?: string) => {
  const result = await port.readDatabase({
    projectId,
    read: databaseId
      ? { mode: "database", target: { kind: "database", databaseId: parseDatabaseId(databaseId) } }
      : { mode: "database", target: { kind: "project_default" } },
  });
  if (!result.ok) throw new Error(`Read library/locations Database: ${result.error.message}`);
  if (result.value.value.kind !== "database") throw new Error("Expected a Database descriptor");
  return { ...result.value.value.value, storeEpoch: result.value.storeEpoch };
};

const materialize = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const atlas = await port.createProject({ name: "Atlas", sources: [workspace] });
  const beacon = await port.createProject({ name: "Beacon", sources: [workspace] });
  if (!atlas.defaultDatabaseViewId) throw new Error("Atlas has no default Database View");

  const pageIdsByKey = {
    atlasLaunchPlan: createUuidV7(),
    atlasRisks: createUuidV7(),
    beaconLaunchPlan: createUuidV7(),
    q4Roadmap: createUuidV7(),
    milestones: createUuidV7(),
    interviewNotes: createUuidV7(),
  };
  for (const [key, projectId] of [
    ["atlasLaunchPlan", atlas.id],
    ["beaconLaunchPlan", beacon.id],
  ] as const) {
    await port.createPage({
      key,
      pageId: pageIdsByKey[key],
      operationId: createUuidV7(),
      projectId,
      status: "doing",
      title: titles.launchPlan,
      markdown: "",
    });
  }

  for (const [pageId, title, parentPageId] of [
    [pageIdsByKey.atlasRisks, titles.risks, pageIdsByKey.atlasLaunchPlan],
    [pageIdsByKey.q4Roadmap, titles.roadmap],
    [pageIdsByKey.milestones, titles.milestones, pageIdsByKey.q4Roadmap],
    [pageIdsByKey.interviewNotes, titles.interview],
  ] as const) {
    await port.createStandalonePage({
      pageId,
      title,
      parentPageId,
      documentId: createUuidV7(),
      operationId: createUuidV7(),
      projectId: atlas.id,
    });
  }

  const researchDatabaseId = parseDatabaseId(createUuidV7());
  const researchDataSourceId = parseDataSourceId(createUuidV7());
  await port.createHostedDatabase({
    operationId: createUuidV7(),
    projectId: atlas.id,
    parentPageId: pageIdsByKey.q4Roadmap,
    name: titles.research,
    databaseId: researchDatabaseId,
    dataSourceId: researchDataSourceId,
    viewId: parseDatabaseViewId(createUuidV7()),
  });
  const { storeEpoch } = await readDatabase(port, atlas.id, researchDatabaseId);
  const interview = await port.readPage(atlas.id, pageIdsByKey.interviewNotes);
  const moved = await port.applyDatabase({
    operationId: createUuidV7(),
    projectId: atlas.id,
    actor: { kind: "scenario_seed" },
    storeEpoch,
    operations: [
      {
        kind: "transfer_page",
        pageId: interview.pageId,
        expectedParentRevision: interview.parentRevision,
        expectedActiveMembershipRevision: 0,
        target: { kind: "data_source", dataSourceId: researchDataSourceId },
      },
    ],
  });
  if (!moved.ok) throw new Error(`Place ${titles.interview}: ${moved.error.message}`);

  const chat = await port.createRelatedChat({
    projectId: atlas.id,
    relatedPageIds: [],
    noThreadFallbackTitle: titles.chat,
  });
  return {
    version: 1,
    scenarioId: LIBRARY_LOCATIONS_SCENARIO_ID,
    scenarioRevision: LIBRARY_LOCATIONS_SCENARIO_REVISION,
    projectId: atlas.id,
    databaseViewId: atlas.defaultDatabaseViewId,
    pageIdsByKey,
    entityIdsByKey: {
      beaconProjectId: beacon.id,
      atlasDatabaseId: atlas.databaseId,
      researchDatabaseId,
      atlasChatSessionId: chat.sessionId,
    },
    minimumCommitSeq: moved.value.commitSeq,
    materializedAt: new Date().toISOString(),
  };
};

const parentId = (parent: PageParent): string => {
  switch (parent.kind) {
    case "library":
      return parent.libraryId;
    case "page":
      return parent.pageId;
    case "data_source":
      return parent.dataSourceId;
  }
};

const inspect = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<LibraryLocationsScenarioFacts> => {
  const facts = requireLibraryLocationsScenarioFacts({
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    beaconProjectId: manifest.entityIdsByKey?.beaconProjectId,
    atlasDatabaseId: manifest.entityIdsByKey?.atlasDatabaseId,
    researchDatabaseId: manifest.entityIdsByKey?.researchDatabaseId,
    atlasChatSessionId: manifest.entityIdsByKey?.atlasChatSessionId,
    atlasProjectId: manifest.projectId,
    atlasDatabaseViewId: manifest.databaseViewId,
    atlasLaunchPlanId: manifest.pageIdsByKey.atlasLaunchPlan,
    atlasRisksId: manifest.pageIdsByKey.atlasRisks,
    beaconLaunchPlanId: manifest.pageIdsByKey.beaconLaunchPlan,
    q4RoadmapId: manifest.pageIdsByKey.q4Roadmap,
    milestonesId: manifest.pageIdsByKey.milestones,
    interviewNotesId: manifest.pageIdsByKey.interviewNotes,
  });
  const [atlas, beacon, research, roadmapBody, chat] = await Promise.all([
    readDatabase(port, facts.atlasProjectId),
    readDatabase(port, facts.beaconProjectId),
    readDatabase(port, facts.atlasProjectId, facts.researchDatabaseId),
    port.readPageBlockTree(facts.atlasProjectId, facts.q4RoadmapId),
    port.readSession(facts.atlasChatSessionId),
  ]);
  const atlasView = atlas.views.find((view) => view.viewId === facts.atlasDatabaseViewId);
  const beaconView = beacon.views.find((view) => view.viewId === beacon.database.defaultViewId);
  const [researchSource] = research.dataSources;
  if (
    atlas.database.databaseId !== facts.atlasDatabaseId ||
    atlas.database.defaultViewId !== facts.atlasDatabaseViewId ||
    atlas.database.name !== "Atlas DB" ||
    !atlasView ||
    !beaconView ||
    atlas.database.databaseId === beacon.database.databaseId
  ) {
    throw new Error("library/locations Project Databases are invalid");
  }
  if (
    research.database.name !== titles.research ||
    research.database.databaseId === atlas.database.databaseId ||
    research.database.databaseId === beacon.database.databaseId ||
    !researchSource ||
    !roadmapBody.some((block) => block.type === "database" && block.id === facts.researchDatabaseId)
  ) {
    throw new Error(`Expected ${titles.research} inside ${titles.roadmap}`);
  }
  if (
    chat?.projectId !== facts.atlasProjectId ||
    chat.thread ||
    chat.noThreadFallbackTitle !== titles.chat
  ) {
    throw new Error(`Expected a threadless Atlas chat titled ${titles.chat}`);
  }

  const checkPage = async (
    pageId: string,
    title: string,
    parent: PageParent,
    projectId = facts.atlasProjectId,
  ) => {
    const page = await port.readPage(projectId, pageId, manifest.minimumCommitSeq);
    if (
      page.title !== title ||
      page.parent.kind !== parent.kind ||
      parentId(page.parent) !== parentId(parent)
    ) {
      throw new Error(`Expected ${title} (${pageId}) under ${parent.kind} ${parentId(parent)}`);
    }
  };

  await Promise.all([
    checkPage(facts.atlasLaunchPlanId, titles.launchPlan, {
      kind: "data_source",
      dataSourceId: atlasView.dataSourceId,
    }),
    checkPage(facts.atlasRisksId, titles.risks, { kind: "page", pageId: facts.atlasLaunchPlanId }),
    checkPage(
      facts.beaconLaunchPlanId,
      titles.launchPlan,
      { kind: "data_source", dataSourceId: beaconView.dataSourceId },
      facts.beaconProjectId,
    ),
    checkPage(facts.q4RoadmapId, titles.roadmap, {
      kind: "library",
      libraryId: atlas.database.libraryId,
    }),
    checkPage(facts.milestonesId, titles.milestones, { kind: "page", pageId: facts.q4RoadmapId }),
    checkPage(facts.interviewNotesId, titles.interview, {
      kind: "data_source",
      dataSourceId: researchSource.dataSourceId,
    }),
  ]);
  return facts;
};

export const libraryLocationsScenario: ScenarioDomainRecipe = {
  id: LIBRARY_LOCATIONS_SCENARIO_ID,
  revision: LIBRARY_LOCATIONS_SCENARIO_REVISION,
  materialize,
  inspect,
  parseFacts: requireLibraryLocationsScenarioFacts,
};
