import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const SIDEBAR_CUSTOM_SECTIONS_SCENARIO_ID = "sidebar/custom-sections" as const;
export const SIDEBAR_CUSTOM_SECTIONS_SCENARIO_REVISION = 2 as const;

const SECTION_KEY = "workSection";
const RUNNING_SESSION_KEY = "runningSession";
const FIRST_DRAFT_KEY = "firstDraft";
const INBOX_PROJECT_KEY = "inboxProject";
const INBOX_SESSION_KEY = "inboxSession";
const SEEDED_DRAFT_COUNT = 51;

interface SidebarCustomSectionsScenarioFacts extends ScenarioFacts {
  readonly sectionId: string;
  readonly directItemCount: number;
  readonly effectiveSessionCount: number;
  readonly hasRunning: boolean;
  readonly hasUnread: boolean;
  readonly firstDraftSessionId: string;
  readonly runningSessionId: string;
  readonly inboxProjectId: string;
  readonly inboxSessionId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const requireSidebarCustomSectionsFacts = (
  value: unknown,
): SidebarCustomSectionsScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  if (
    envelope.scenarioId !== SIDEBAR_CUSTOM_SECTIONS_SCENARIO_ID ||
    envelope.scenarioRevision !== SIDEBAR_CUSTOM_SECTIONS_SCENARIO_REVISION ||
    !isRecord(value) ||
    typeof value.sectionId !== "string" ||
    typeof value.directItemCount !== "number" ||
    typeof value.effectiveSessionCount !== "number" ||
    typeof value.hasRunning !== "boolean" ||
    typeof value.hasUnread !== "boolean" ||
    typeof value.firstDraftSessionId !== "string" ||
    typeof value.runningSessionId !== "string" ||
    typeof value.inboxProjectId !== "string" ||
    typeof value.inboxSessionId !== "string"
  ) {
    throw new Error("sidebar/custom-sections facts are invalid");
  }
  return value as unknown as SidebarCustomSectionsScenarioFacts;
};

const materialize = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({
    name: "Section Project",
    sources: [workspace],
  });
  if (!project.defaultDatabaseViewId) {
    throw new Error("sidebar/custom-sections Project has no default Database View");
  }
  const section = await port.createSidebarSection({
    name: "Work",
    initialItem: { kind: "project", projectId: project.id },
  });
  const inboxProject = await port.createProject({
    name: "Inbox Project",
    sources: [workspace],
  });
  const inbox = await port.createRelatedChat({
    projectId: inboxProject.id,
    initialPageIds: [],
    noThreadFallbackTitle: "Inbox chat",
    thread: {
      threadId: createUuidV7(),
      threadName: "Inbox chat",
      threadPreview: "Move this chat into the custom Section",
      statusType: "idle",
      statusActiveFlags: [],
      unread: false,
    },
  });
  const runningThreadId = createUuidV7();
  const running = await port.createRelatedChat({
    projectId: project.id,
    initialPageIds: [],
    noThreadFallbackTitle: "Running Section task",
    thread: {
      threadId: runningThreadId,
      threadName: "Running Section task",
      threadPreview: "Verifying aggregate Section activity",
      statusType: "active",
      statusActiveFlags: [],
      unread: true,
    },
  });
  await port.moveSidebarSectionItem({
    item: { kind: "session", sessionId: running.sessionId },
    sectionId: section.sectionId,
    placement: { kind: "end" },
  });

  const drafts = [];
  for (let index = 0; index < SEEDED_DRAFT_COUNT; index += 1) {
    drafts.push(
      await port.createSessionInSidebarSection({
        sectionId: section.sectionId,
        title: `Section draft ${String(index + 1).padStart(2, "0")}`,
      }),
    );
  }
  const projectBoundary = drafts[1];
  if (!projectBoundary) throw new Error("sidebar/custom-sections project boundary is missing");
  await port.moveSidebarSectionItem({
    item: { kind: "project", projectId: project.id },
    sectionId: section.sectionId,
    placement: {
      kind: "before",
      item: { kind: "session", sessionId: projectBoundary.id },
    },
  });
  const firstDraft = drafts[0];
  if (!firstDraft) throw new Error("sidebar/custom-sections draft fixture is missing");

  return {
    version: 1,
    scenarioId: SIDEBAR_CUSTOM_SECTIONS_SCENARIO_ID,
    scenarioRevision: SIDEBAR_CUSTOM_SECTIONS_SCENARIO_REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey: {},
    entityIdsByKey: {
      [SECTION_KEY]: section.sectionId,
      [RUNNING_SESSION_KEY]: running.sessionId,
      [FIRST_DRAFT_KEY]: firstDraft.id,
      [INBOX_PROJECT_KEY]: inboxProject.id,
      [INBOX_SESSION_KEY]: inbox.sessionId,
    },
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
};

const requireEntityId = (manifest: ScenarioManifest, key: string): string => {
  const value = manifest.entityIdsByKey?.[key];
  if (value) return value;
  throw new Error(`sidebar/custom-sections manifest has no ${key}`);
};

const inspect = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<SidebarCustomSectionsScenarioFacts> => {
  const sectionId = requireEntityId(manifest, SECTION_KEY);
  const sections = await port.listSidebarSections();
  const section = sections.find((candidate) => candidate.sectionId === sectionId);
  const itemWindow = await port.listSidebarSectionItems(sectionId);
  if (
    !section ||
    section.name !== "Work" ||
    section.directItemCount !== SEEDED_DRAFT_COUNT + 2 ||
    section.effectiveSessionCount !== SEEDED_DRAFT_COUNT + 1 ||
    !section.hasRunning ||
    !section.hasUnread ||
    itemWindow.hasMore ||
    itemWindow.items.length !== SEEDED_DRAFT_COUNT + 2
  ) {
    throw new Error(
      `sidebar/custom-sections materialized facts do not match revision ${SIDEBAR_CUSTOM_SECTIONS_SCENARIO_REVISION}`,
    );
  }
  return {
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    sectionId,
    directItemCount: section.directItemCount,
    effectiveSessionCount: section.effectiveSessionCount,
    hasRunning: section.hasRunning,
    hasUnread: section.hasUnread,
    firstDraftSessionId: requireEntityId(manifest, FIRST_DRAFT_KEY),
    runningSessionId: requireEntityId(manifest, RUNNING_SESSION_KEY),
    inboxProjectId: requireEntityId(manifest, INBOX_PROJECT_KEY),
    inboxSessionId: requireEntityId(manifest, INBOX_SESSION_KEY),
  };
};

export const sidebarCustomSectionsScenario: ScenarioDomainRecipe = {
  id: SIDEBAR_CUSTOM_SECTIONS_SCENARIO_ID,
  revision: SIDEBAR_CUSTOM_SECTIONS_SCENARIO_REVISION,
  materialize,
  inspect,
  parseFacts: requireSidebarCustomSectionsFacts,
};
