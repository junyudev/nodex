import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioPageSeed,
  type ScenarioSeedPort,
} from "../contracts";

export const PAGE_RELATED_CHAT_ACTIVITY_SCENARIO_ID = "page/related-chat-activity" as const;
export const PAGE_RELATED_CHAT_ACTIVITY_SCENARIO_REVISION = 1 as const;
export const PAGE_RELATED_CHAT_ACTIVITY_PAGE_KEY = "activityPage" as const;
export const PAGE_RELATED_CHAT_ACTIVITY_OPEN_ACTION_PAGE_KEY = "openActionPage" as const;
export const PAGE_RELATED_CHAT_ACTIVITY_ATTACHED_SESSION_KEY = "attachedSession" as const;
export const PAGE_RELATED_CHAT_ACTIVITY_THREADLESS_SESSION_KEY = "threadlessSession" as const;
export const PAGE_RELATED_CHAT_ACTIVITY_THREAD_KEY = "workingThread" as const;

export interface PageRelatedChatActivityScenarioFacts extends ScenarioFacts {
  readonly activityPage: {
    readonly pageId: string;
    readonly relatedCount: number;
    readonly workingCount: number;
    readonly unreadCount: number;
    readonly soleSessionId: string | null;
  };
  readonly openActionPage: {
    readonly pageId: string;
    readonly relatedCount: number;
  };
  readonly chats: {
    readonly attachedSessionId: string;
    readonly threadlessSessionId: string;
    readonly workingThreadId: string;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const requirePageRelatedChatActivityScenarioFacts = (
  value: unknown,
): PageRelatedChatActivityScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  const candidate = value as Record<string, unknown>;
  const activityPage = candidate.activityPage;
  const openActionPage = candidate.openActionPage;
  const chats = candidate.chats;
  if (
    !isRecord(activityPage) ||
    typeof activityPage.pageId !== "string" ||
    typeof activityPage.relatedCount !== "number" ||
    typeof activityPage.workingCount !== "number" ||
    typeof activityPage.unreadCount !== "number" ||
    (activityPage.soleSessionId !== null && typeof activityPage.soleSessionId !== "string") ||
    !isRecord(openActionPage) ||
    typeof openActionPage.pageId !== "string" ||
    typeof openActionPage.relatedCount !== "number" ||
    !isRecord(chats) ||
    typeof chats.attachedSessionId !== "string" ||
    typeof chats.threadlessSessionId !== "string" ||
    typeof chats.workingThreadId !== "string"
  ) {
    throw new Error("page/related-chat-activity facts are invalid");
  }
  if (
    envelope.scenarioId !== PAGE_RELATED_CHAT_ACTIVITY_SCENARIO_ID ||
    envelope.scenarioRevision !== PAGE_RELATED_CHAT_ACTIVITY_SCENARIO_REVISION
  ) {
    throw new Error("page/related-chat-activity facts identity is invalid");
  }
  return value as PageRelatedChatActivityScenarioFacts;
};

const materializePageRelatedChatActivity = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({
    name: "Related Chat Activity",
    sources: [workspace],
  });
  if (!project.defaultDatabaseViewId) {
    throw new Error("page/related-chat-activity Project has no default Database View");
  }
  const pages: readonly ScenarioPageSeed[] = [
    {
      key: PAGE_RELATED_CHAT_ACTIVITY_PAGE_KEY,
      pageId: createUuidV7(),
      operationId: createUuidV7(),
      projectId: project.id,
      status: "build",
      title: "Trace related Chat activity",
      nfm: "Verify that durable Page relationships project execution and unread activity.",
    },
    {
      key: PAGE_RELATED_CHAT_ACTIVITY_OPEN_ACTION_PAGE_KEY,
      pageId: createUuidV7(),
      operationId: createUuidV7(),
      projectId: project.id,
      status: "plan",
      title: "Open a durable related Chat",
      nfm: "Use the Page action to create a Chat whose relationship survives restart.",
    },
  ];
  for (const page of pages) await port.createPage(page);
  const activityPageId = pages[0]?.pageId;
  const openActionPageId = pages[1]?.pageId;
  if (!activityPageId || !openActionPageId) {
    throw new Error("page/related-chat-activity Page fixtures are missing");
  }

  const workingThreadId = createUuidV7();
  const attached = await port.createRelatedChat({
    projectId: project.id,
    initialPageIds: [activityPageId],
    noThreadFallbackTitle: "Implement activity projection",
    thread: {
      threadId: workingThreadId,
      threadName: "Implement activity projection",
      threadPreview: "Projecting durable execution and unread state",
      statusType: "active",
      statusActiveFlags: [],
      unread: true,
    },
  });
  const threadless = await port.createRelatedChat({
    projectId: project.id,
    initialPageIds: [activityPageId],
    noThreadFallbackTitle: "Review relationship model",
  });

  return {
    version: 1,
    scenarioId: PAGE_RELATED_CHAT_ACTIVITY_SCENARIO_ID,
    scenarioRevision: PAGE_RELATED_CHAT_ACTIVITY_SCENARIO_REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey: {
      [PAGE_RELATED_CHAT_ACTIVITY_PAGE_KEY]: activityPageId,
      [PAGE_RELATED_CHAT_ACTIVITY_OPEN_ACTION_PAGE_KEY]: openActionPageId,
    },
    entityIdsByKey: {
      [PAGE_RELATED_CHAT_ACTIVITY_ATTACHED_SESSION_KEY]: attached.sessionId,
      [PAGE_RELATED_CHAT_ACTIVITY_THREADLESS_SESSION_KEY]: threadless.sessionId,
      [PAGE_RELATED_CHAT_ACTIVITY_THREAD_KEY]: workingThreadId,
    },
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
};

const requireManifestIdentity = (manifest: ScenarioManifest, key: string): string => {
  const value = manifest.entityIdsByKey?.[key];
  if (value) return value;
  throw new Error(`page/related-chat-activity manifest has no ${key}`);
};

const inspectPageRelatedChatActivity = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<PageRelatedChatActivityScenarioFacts> => {
  const activityPageId = manifest.pageIdsByKey[PAGE_RELATED_CHAT_ACTIVITY_PAGE_KEY];
  const openActionPageId = manifest.pageIdsByKey[PAGE_RELATED_CHAT_ACTIVITY_OPEN_ACTION_PAGE_KEY];
  if (!activityPageId || !openActionPageId) {
    throw new Error("page/related-chat-activity manifest has no Page fixtures");
  }
  const attachedSessionId = requireManifestIdentity(
    manifest,
    PAGE_RELATED_CHAT_ACTIVITY_ATTACHED_SESSION_KEY,
  );
  const threadlessSessionId = requireManifestIdentity(
    manifest,
    PAGE_RELATED_CHAT_ACTIVITY_THREADLESS_SESSION_KEY,
  );
  const workingThreadId = requireManifestIdentity(manifest, PAGE_RELATED_CHAT_ACTIVITY_THREAD_KEY);
  const [activity, chats] = await Promise.all([
    port.readPageChatActivity(manifest.projectId, [activityPageId, openActionPageId]),
    port.readPageChats(manifest.projectId, activityPageId),
  ]);
  const activitySummary = activity.summaries.find((item) => item.pageId === activityPageId);
  const openActionSummary = activity.summaries.find((item) => item.pageId === openActionPageId);
  const attached = chats.items.find((item) => item.sessionId === attachedSessionId);
  const threadless = chats.items.find((item) => item.sessionId === threadlessSessionId);
  if (
    !activitySummary ||
    !openActionSummary ||
    activitySummary.relatedCount !== 2 ||
    activitySummary.workingCount !== 1 ||
    activitySummary.waitingOnApprovalCount !== 0 ||
    activitySummary.waitingOnUserInputCount !== 0 ||
    activitySummary.errorCount !== 0 ||
    activitySummary.unreadCount !== 1 ||
    activitySummary.soleSessionId !== null ||
    openActionSummary.relatedCount !== 0 ||
    attached?.threadId !== workingThreadId ||
    attached.threadStatus?.statusType !== "active" ||
    attached.threadStatus.activeFlags.length !== 0 ||
    attached.unread !== true ||
    threadless?.threadId !== null ||
    threadless.unread !== false
  ) {
    throw new Error(
      `page/related-chat-activity materialized facts do not match revision ${PAGE_RELATED_CHAT_ACTIVITY_SCENARIO_REVISION}`,
    );
  }
  return {
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    activityPage: {
      pageId: activityPageId,
      relatedCount: activitySummary.relatedCount,
      workingCount: activitySummary.workingCount,
      unreadCount: activitySummary.unreadCount,
      soleSessionId: activitySummary.soleSessionId,
    },
    openActionPage: {
      pageId: openActionPageId,
      relatedCount: openActionSummary.relatedCount,
    },
    chats: { attachedSessionId, threadlessSessionId, workingThreadId },
  };
};

export const pageRelatedChatActivityScenario: ScenarioDomainRecipe = {
  id: PAGE_RELATED_CHAT_ACTIVITY_SCENARIO_ID,
  revision: PAGE_RELATED_CHAT_ACTIVITY_SCENARIO_REVISION,
  materialize: materializePageRelatedChatActivity,
  inspect: inspectPageRelatedChatActivity,
  parseFacts: requirePageRelatedChatActivityScenarioFacts,
};
