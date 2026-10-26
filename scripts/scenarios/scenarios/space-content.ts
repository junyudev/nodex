import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const SPACE_CONTENT_SCENARIO_ID = "space/content" as const;
export const SPACE_CONTENT_SCENARIO_REVISION = 1 as const;

/** Root Pages in Library order, after the Project's own Database. */
export const SPACE_CONTENT_PAGE_TITLES = [
  "Product principles",
  "Q4 roadmap",
  "Weekly review",
  "Hiring plan",
  "Design system",
  "Launch checklist",
  "Customer interviews",
  "Pricing research",
  "Onboarding flow",
  "Incident runbook",
  "Release notes",
  "Team rituals",
  "Reading list",
  "Architecture notes",
  "Support macros",
  "Partner program",
  "Brand voice",
  "Metrics glossary",
  "Offsite agenda",
  "Retrospectives",
  "Ideas backlog",
  "Travel policy",
] as const;

export interface SpaceContentScenarioFacts extends ScenarioFacts {
  readonly projectId: string;
  readonly pageIds: readonly string[];
}

export const requireSpaceContentScenarioFacts = (value: unknown): SpaceContentScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  const candidate = value as Record<string, unknown>;
  if (
    envelope.scenarioId !== SPACE_CONTENT_SCENARIO_ID ||
    envelope.scenarioRevision !== SPACE_CONTENT_SCENARIO_REVISION ||
    typeof candidate.projectId !== "string" ||
    !Array.isArray(candidate.pageIds) ||
    candidate.pageIds.length !== SPACE_CONTENT_PAGE_TITLES.length ||
    !candidate.pageIds.every((pageId) => typeof pageId === "string")
  ) {
    throw new Error("space/content facts are invalid");
  }
  return value as SpaceContentScenarioFacts;
};

const pageKey = (index: number): string => `page${String(index + 1).padStart(2, "0")}`;

const materialize = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({ name: "Atlas", sources: [workspace] });
  if (!project.defaultDatabaseViewId) {
    throw new Error("space/content Project has no default Database View");
  }
  const pageIdsByKey: Record<string, string> = {};
  // Sequential creation fixes the Library order the sidebar must preserve.
  for (const [index, title] of SPACE_CONTENT_PAGE_TITLES.entries()) {
    const pageId = createUuidV7();
    await port.createStandalonePage({
      pageId,
      documentId: createUuidV7(),
      operationId: createUuidV7(),
      projectId: project.id,
      title,
    });
    pageIdsByKey[pageKey(index)] = pageId;
  }
  return {
    version: 1,
    scenarioId: SPACE_CONTENT_SCENARIO_ID,
    scenarioRevision: SPACE_CONTENT_SCENARIO_REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey,
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
};

const inspect = async (
  _port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<SpaceContentScenarioFacts> =>
  requireSpaceContentScenarioFacts({
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    projectId: manifest.projectId,
    pageIds: SPACE_CONTENT_PAGE_TITLES.map((_, index) => {
      const pageId = manifest.pageIdsByKey[pageKey(index)];
      if (!pageId) throw new Error("space/content manifest is incomplete");
      return pageId;
    }),
  });

export const spaceContentScenario: ScenarioDomainRecipe = {
  id: SPACE_CONTENT_SCENARIO_ID,
  revision: SPACE_CONTENT_SCENARIO_REVISION,
  materialize,
  inspect,
  parseFacts: requireSpaceContentScenarioFacts,
};
