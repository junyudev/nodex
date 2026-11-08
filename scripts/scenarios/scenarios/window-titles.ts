import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const WINDOW_TITLES_SCENARIO_ID = "window/titles" as const;
export const WINDOW_TITLES_SCENARIO_REVISION = 1 as const;

/** Content whose names each window title presents. */
export const WINDOW_TITLES_CONTENT = {
  primaryProject: "Atlas",
  secondaryProject: "Beacon",
  primaryChat: "Draft the launch plan",
  secondaryChat: "Fix the flaky sync test",
  spacePage: "Q4 roadmap",
} as const;

export interface WindowTitlesScenarioFacts extends ScenarioFacts {
  readonly primaryProjectId: string;
  readonly secondaryProjectId: string;
  readonly primaryChatSessionId: string;
  readonly secondaryChatSessionId: string;
  readonly spacePageId: string;
}

const ENTITY_KEYS = [
  "primaryProjectId",
  "secondaryProjectId",
  "primaryChatSessionId",
  "secondaryChatSessionId",
] as const;

export const requireWindowTitlesScenarioFacts = (value: unknown): WindowTitlesScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  const candidate = value as Record<string, unknown>;
  if (
    envelope.scenarioId !== WINDOW_TITLES_SCENARIO_ID ||
    envelope.scenarioRevision !== WINDOW_TITLES_SCENARIO_REVISION ||
    ![...ENTITY_KEYS, "spacePageId"].every((key) => typeof candidate[key] === "string")
  ) {
    throw new Error("window/titles facts are invalid");
  }
  return value as WindowTitlesScenarioFacts;
};

const materialize = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const primary = await port.createProject({
    name: WINDOW_TITLES_CONTENT.primaryProject,
    sources: [workspace],
  });
  const secondary = await port.createProject({
    name: WINDOW_TITLES_CONTENT.secondaryProject,
    sources: [workspace],
  });
  if (!primary.defaultDatabaseViewId) {
    throw new Error("window/titles Project has no default Database View");
  }
  const spacePageId = createUuidV7();
  await port.createStandalonePage({
    pageId: spacePageId,
    documentId: createUuidV7(),
    operationId: createUuidV7(),
    projectId: primary.id,
    title: WINDOW_TITLES_CONTENT.spacePage,
  });
  const primaryChat = await port.createRelatedChat({
    projectId: primary.id,
    relatedPageIds: [],
    noThreadFallbackTitle: WINDOW_TITLES_CONTENT.primaryChat,
  });
  const secondaryChat = await port.createRelatedChat({
    projectId: secondary.id,
    relatedPageIds: [],
    noThreadFallbackTitle: WINDOW_TITLES_CONTENT.secondaryChat,
  });
  return {
    version: 1,
    scenarioId: WINDOW_TITLES_SCENARIO_ID,
    scenarioRevision: WINDOW_TITLES_SCENARIO_REVISION,
    projectId: primary.id,
    databaseViewId: primary.defaultDatabaseViewId,
    pageIdsByKey: { spacePage: spacePageId },
    entityIdsByKey: {
      primaryProjectId: primary.id,
      secondaryProjectId: secondary.id,
      primaryChatSessionId: primaryChat.sessionId,
      secondaryChatSessionId: secondaryChat.sessionId,
    },
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
};

const inspect = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<WindowTitlesScenarioFacts> => {
  const entity = (key: (typeof ENTITY_KEYS)[number]): string => {
    const value = manifest.entityIdsByKey?.[key];
    if (!value) throw new Error(`window/titles manifest has no ${key}`);
    return value;
  };
  const spacePageId = manifest.pageIdsByKey.spacePage;
  if (!spacePageId) throw new Error("window/titles manifest has no Space Page");
  const chats = await Promise.all(
    (["primaryChatSessionId", "secondaryChatSessionId"] as const).map((key) =>
      port.readSession(entity(key)),
    ),
  );
  if (chats.some((chat) => !chat)) throw new Error("window/titles chats are missing");
  return requireWindowTitlesScenarioFacts({
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    primaryProjectId: entity("primaryProjectId"),
    secondaryProjectId: entity("secondaryProjectId"),
    primaryChatSessionId: entity("primaryChatSessionId"),
    secondaryChatSessionId: entity("secondaryChatSessionId"),
    spacePageId,
  });
};

export const windowTitlesScenario: ScenarioDomainRecipe = {
  id: WINDOW_TITLES_SCENARIO_ID,
  revision: WINDOW_TITLES_SCENARIO_REVISION,
  materialize,
  inspect,
  parseFacts: requireWindowTitlesScenarioFacts,
};
