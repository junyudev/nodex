import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioRelatedChatSeed,
  type ScenarioSeedPort,
} from "../contracts";

export const SIDEBAR_CHAT_STATUS_SCENARIO_ID = "sidebar/chat-status" as const;
export const SIDEBAR_CHAT_STATUS_SCENARIO_REVISION = 2 as const;

const PROJECTS = {
  statusProject: "Status Project",
  collapsedWaitingProject: "Collapsed Waiting",
  collapsedUnreadProject: "Collapsed Unread",
} as const;

type ChatRecipe = {
  readonly projectKey: keyof typeof PROJECTS;
  readonly title: string;
  readonly inReview?: boolean;
} & (
  | {
      readonly thread: Pick<
        NonNullable<ScenarioRelatedChatSeed["thread"]>,
        "statusType" | "statusActiveFlags"
      >;
      readonly unread?: never;
    }
  | { readonly thread?: undefined; readonly unread: boolean }
);

const CHATS = {
  waitingApproval: {
    projectKey: "statusProject",
    title: "Waiting for approval",
    thread: { statusType: "active", statusActiveFlags: ["waitingOnApproval"] },
  },
  waitingAnswer: {
    projectKey: "statusProject",
    title: "Waiting for an answer",
    thread: { statusType: "active", statusActiveFlags: ["waitingOnUserInput"] },
  },
  working: {
    projectKey: "statusProject",
    title: "Working",
    thread: { statusType: "active", statusActiveFlags: [] },
  },
  unread: {
    projectKey: "statusProject",
    title: "Unread reply",
    unread: true,
  },
  quiet: {
    projectKey: "statusProject",
    title: "Quiet chat",
    thread: { statusType: "idle", statusActiveFlags: [] },
  },
  collapsedWaiting: {
    projectKey: "collapsedWaitingProject",
    title: "Waiting for approval",
    thread: { statusType: "active", statusActiveFlags: ["waitingOnApproval"] },
  },
  collapsedWaitingUnread: {
    projectKey: "collapsedWaitingProject",
    title: "Unread reply",
    unread: true,
  },
  collapsedUnread: {
    projectKey: "collapsedUnreadProject",
    title: "Unread reply",
    unread: true,
  },
  collapsedUnreadWorking: {
    projectKey: "collapsedUnreadProject",
    title: "Working",
    thread: { statusType: "active", statusActiveFlags: [] },
  },
  reviewWaiting: {
    projectKey: "statusProject",
    title: "Waiting for an answer",
    thread: { statusType: "active", statusActiveFlags: ["waitingOnUserInput"] },
    inReview: true,
  },
  reviewUnread: {
    projectKey: "statusProject",
    title: "Unread reply",
    unread: true,
    inReview: true,
  },
} as const satisfies Readonly<Record<string, ChatRecipe>>;

export interface SidebarChatStatusScenarioFacts extends ScenarioFacts {
  readonly projectIdsByKey: Readonly<Record<keyof typeof PROJECTS, string>>;
  readonly sessionIdsByKey: Readonly<Record<keyof typeof CHATS, string>>;
  readonly reviewSectionId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const requireSidebarChatStatusFacts = (value: unknown): SidebarChatStatusScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  if (
    envelope.scenarioId !== SIDEBAR_CHAT_STATUS_SCENARIO_ID ||
    envelope.scenarioRevision !== SIDEBAR_CHAT_STATUS_SCENARIO_REVISION ||
    !isRecord(value) ||
    !isRecord(value.projectIdsByKey) ||
    !isRecord(value.sessionIdsByKey) ||
    !isIdentity(value.reviewSectionId)
  ) {
    throw new Error("sidebar/chat-status facts are invalid");
  }
  const { projectIdsByKey, sessionIdsByKey } = value;
  if (
    !Object.keys(PROJECTS).every((key) => isIdentity(projectIdsByKey[key])) ||
    !Object.keys(CHATS).every((key) => isIdentity(sessionIdsByKey[key]))
  ) {
    throw new Error("sidebar/chat-status facts have missing identities");
  }
  return value as unknown as SidebarChatStatusScenarioFacts;
};

const requireId = (manifest: ScenarioManifest, key: string): string => {
  const id = manifest.entityIdsByKey?.[key];
  if (id) return id;
  throw new Error(`sidebar/chat-status manifest has no ${key}`);
};

const materialize = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const projects = [];
  for (const [key, name] of Object.entries(PROJECTS)) {
    projects.push([key, await port.createProject({ name, sources: [workspace] })] as const);
  }
  const project = projects.find(([key]) => key === "statusProject")?.[1];
  if (!project?.defaultDatabaseViewId) {
    throw new Error("sidebar/chat-status Project has no default Database View");
  }
  const section = await port.createSidebarSection({ name: "Review" });
  const entityIdsByKey: Record<string, string> = {
    ...Object.fromEntries(projects.map(([key, created]) => [key, created.id])),
    reviewSection: section.sectionId,
  };
  for (const [key, recipe] of Object.entries<ChatRecipe>(CHATS)) {
    const projectId = entityIdsByKey[recipe.projectKey];
    if (!projectId) throw new Error(`sidebar/chat-status Project ${recipe.projectKey} is missing`);
    const chat = await port.createRelatedChat({
      projectId,
      initialPageIds: [],
      noThreadFallbackTitle: recipe.title,
      ...(recipe.thread
        ? {
            thread: {
              threadId: createUuidV7(),
              threadName: recipe.title,
              threadPreview: "",
              ...recipe.thread,
              unread: false,
            },
          }
        : {}),
    });
    entityIdsByKey[key] = chat.sessionId;
    if (chat.threadId) entityIdsByKey[`${key}Thread`] = chat.threadId;
    if (recipe.unread) await port.setSessionUnread(chat.sessionId, true);
    if (!recipe.inReview) continue;
    await port.moveSidebarSectionItem({
      item: { kind: "session", sessionId: chat.sessionId },
      sectionId: section.sectionId,
      placement: { kind: "end" },
    });
  }
  return {
    version: 1,
    scenarioId: SIDEBAR_CHAT_STATUS_SCENARIO_ID,
    scenarioRevision: SIDEBAR_CHAT_STATUS_SCENARIO_REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey: {},
    entityIdsByKey,
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
};

const inspect = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<SidebarChatStatusScenarioFacts> => {
  const sessionIdsByKey: Record<string, string> = {};
  for (const [key, recipe] of Object.entries<ChatRecipe>(CHATS)) {
    const sessionId = requireId(manifest, key);
    const session = await port.readSession(sessionId);
    if (
      !session ||
      session.projectId !== requireId(manifest, recipe.projectKey) ||
      session.displayTitle !== recipe.title ||
      session.archived ||
      session.unread !== Boolean(recipe.unread)
    ) {
      throw new Error(`sidebar/chat-status Chat ${key} did not materialize`);
    }
    if (!recipe.thread && session.thread !== null) {
      throw new Error(`sidebar/chat-status Chat ${key} must be threadless`);
    }
    if (
      recipe.thread &&
      (session.thread?.threadId !== requireId(manifest, `${key}Thread`) ||
        session.thread.statusType !== recipe.thread.statusType ||
        session.thread.statusActiveFlags.length !== recipe.thread.statusActiveFlags.length ||
        !recipe.thread.statusActiveFlags.every((flag) =>
          session.thread?.statusActiveFlags.includes(flag),
        ))
    ) {
      throw new Error(`sidebar/chat-status Chat ${key} has unexpected execution status`);
    }
    sessionIdsByKey[key] = sessionId;
  }
  const reviewSectionId = requireId(manifest, "reviewSection");
  const section = (await port.listSidebarSections()).find(
    (candidate) => candidate.sectionId === reviewSectionId,
  );
  const window = await port.listSidebarSectionItems(reviewSectionId);
  const reviewIds = Object.entries<ChatRecipe>(CHATS)
    .filter(([, recipe]) => recipe.inReview)
    .map(([key]) => requireId(manifest, key));
  if (
    section?.name !== "Review" ||
    section.directItemCount !== reviewIds.length ||
    section.effectiveSessionCount !== reviewIds.length ||
    window.hasMore ||
    window.items.length !== reviewIds.length ||
    window.items.some((item) => item.kind !== "session" || !reviewIds.includes(item.session.id))
  ) {
    throw new Error("sidebar/chat-status Review Section did not materialize");
  }
  return requireSidebarChatStatusFacts({
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    projectIdsByKey: Object.fromEntries(
      Object.keys(PROJECTS).map((key) => [key, requireId(manifest, key)]),
    ),
    sessionIdsByKey,
    reviewSectionId,
  });
};

export const sidebarChatStatusScenario: ScenarioDomainRecipe = {
  id: SIDEBAR_CHAT_STATUS_SCENARIO_ID,
  revision: SIDEBAR_CHAT_STATUS_SCENARIO_REVISION,
  materialize,
  inspect,
  parseFacts: requireSidebarChatStatusFacts,
};
