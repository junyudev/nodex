import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const SIDEBAR_PAGINATION_SCENARIO_ID = "sidebar/pagination" as const;
export const SIDEBAR_PAGINATION_SCENARIO_REVISION = 1 as const;

/** Chats in the paged Project: a first page, several Show more steps, and a short last step. */
export const SIDEBAR_PAGINATION_PROJECT_CHAT_COUNT = 23;
/** Projects in the Projects list, so the list itself pages past its first five groups. */
export const SIDEBAR_PAGINATION_PROJECT_COUNT = 12;

const PAGED_PROJECT_NAME = "Paged Project";

const numbered = (prefix: string, index: number): string =>
  `${prefix} ${String(index + 1).padStart(2, "0")}`;

export interface SidebarPaginationScenarioFacts extends ScenarioFacts {
  readonly pagedProjectId: string;
  readonly pagedProjectChatIds: readonly string[];
}

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);

export const requireSidebarPaginationFacts = (value: unknown): SidebarPaginationScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  const candidate = value as Record<string, unknown>;
  if (
    envelope.scenarioId !== SIDEBAR_PAGINATION_SCENARIO_ID ||
    envelope.scenarioRevision !== SIDEBAR_PAGINATION_SCENARIO_REVISION ||
    typeof candidate.pagedProjectId !== "string" ||
    !isStringArray(candidate.pagedProjectChatIds) ||
    candidate.pagedProjectChatIds.length !== SIDEBAR_PAGINATION_PROJECT_CHAT_COUNT
  ) {
    throw new Error("sidebar/pagination facts are invalid");
  }
  return value as SidebarPaginationScenarioFacts;
};

const chatKey = (index: number): string => numbered("chat", index).replace(" ", "");

const materialize = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  // The newest Project leads the list, so the paged Project is created last to lead it.
  for (let index = SIDEBAR_PAGINATION_PROJECT_COUNT - 1; index >= 1; index -= 1) {
    await port.createProject({ name: numbered("Project", index), sources: [workspace] });
  }
  const pagedProject = await port.createProject({ name: PAGED_PROJECT_NAME, sources: [workspace] });
  if (!pagedProject.defaultDatabaseViewId) {
    throw new Error("sidebar/pagination Project has no default Database View");
  }
  const entityIdsByKey: Record<string, string> = {};
  // The newest chat leads the list, so creating in reverse lists Chat 01 first.
  for (let index = SIDEBAR_PAGINATION_PROJECT_CHAT_COUNT - 1; index >= 0; index -= 1) {
    const chat = await port.createRelatedChat({
      projectId: pagedProject.id,
      relatedPageIds: [],
      noThreadFallbackTitle: numbered("Chat", index),
    });
    entityIdsByKey[chatKey(index)] = chat.sessionId;
  }
  return {
    version: 1,
    scenarioId: SIDEBAR_PAGINATION_SCENARIO_ID,
    scenarioRevision: SIDEBAR_PAGINATION_SCENARIO_REVISION,
    projectId: pagedProject.id,
    databaseViewId: pagedProject.defaultDatabaseViewId,
    pageIdsByKey: {},
    entityIdsByKey,
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
};

const requireId = (manifest: ScenarioManifest, key: string): string => {
  const id = manifest.entityIdsByKey?.[key];
  if (id) return id;
  throw new Error(`sidebar/pagination manifest has no ${key}`);
};

const inspect = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<SidebarPaginationScenarioFacts> => {
  const pagedProjectChatIds: string[] = [];
  for (let index = 0; index < SIDEBAR_PAGINATION_PROJECT_CHAT_COUNT; index += 1) {
    const sessionId = requireId(manifest, chatKey(index));
    const session = await port.readSession(sessionId);
    if (
      session?.projectId !== manifest.projectId ||
      session.displayTitle !== numbered("Chat", index) ||
      session.archived
    ) {
      throw new Error(`sidebar/pagination ${numbered("Chat", index)} did not materialize`);
    }
    pagedProjectChatIds.push(sessionId);
  }
  return requireSidebarPaginationFacts({
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    pagedProjectId: manifest.projectId,
    pagedProjectChatIds,
  });
};

export const sidebarPaginationScenario: ScenarioDomainRecipe = {
  id: SIDEBAR_PAGINATION_SCENARIO_ID,
  revision: SIDEBAR_PAGINATION_SCENARIO_REVISION,
  materialize,
  inspect,
  parseFacts: requireSidebarPaginationFacts,
};
