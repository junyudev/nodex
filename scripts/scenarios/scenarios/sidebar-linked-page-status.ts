import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  isWorkflowStatus,
  WORKFLOW_STATUS_ORDER,
  type WorkflowStatus,
} from "../../../src/shared/workflow-status";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_ID = "sidebar/linked-page-status" as const;
export const SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_REVISION = 2 as const;

const PAGE_TITLES = {
  triage: "Investigate slow search",
  plan: "Plan keyboard navigation",
  build: "Add search shortcuts",
  review: "Review export flow",
  ship: "Ship sidebar polish",
  noStatus: "Search research notes",
} as const;

type PageKey = keyof typeof PAGE_TITLES;

interface ChatRecipe {
  readonly title: string;
  readonly pageKeys: readonly PageKey[];
  readonly expectedStatusOptionId: WorkflowStatus | null;
  readonly pinned: boolean;
}

const CHATS = {
  build: {
    title: "Implement search shortcuts",
    pageKeys: ["build"],
    expectedStatusOptionId: "build",
    pinned: false,
  },
  review: {
    title: "Check export edge cases",
    pageKeys: ["review"],
    expectedStatusOptionId: "review",
    pinned: false,
  },
  ship: {
    title: "Prepare sidebar release",
    pageKeys: ["ship"],
    expectedStatusOptionId: "ship",
    pinned: false,
  },
  triage: {
    title: "Trace search latency",
    pageKeys: ["triage"],
    expectedStatusOptionId: "triage",
    pinned: false,
  },
  plan: {
    title: "Outline keyboard behavior",
    pageKeys: ["plan"],
    expectedStatusOptionId: "plan",
    pinned: false,
  },
  multiple: {
    title: "Coordinate search and export",
    pageKeys: ["build", "review"],
    expectedStatusOptionId: "build",
    pinned: false,
  },
  noStatus: {
    title: "Summarize search research",
    pageKeys: ["noStatus"],
    expectedStatusOptionId: null,
    pinned: false,
  },
  unlinked: {
    title: "Explore command palette ideas",
    pageKeys: [],
    expectedStatusOptionId: null,
    pinned: false,
  },
  pinnedBuild: {
    title: "Track shortcut implementation",
    pageKeys: ["build"],
    expectedStatusOptionId: "build",
    pinned: true,
  },
} as const satisfies Readonly<Record<string, ChatRecipe>>;

export interface SidebarLinkedPageStatusScenarioFacts extends ScenarioFacts {
  readonly pages: Readonly<
    Record<
      PageKey,
      {
        readonly pageId: string;
        readonly title: string;
        readonly statusOptionId: WorkflowStatus | null;
      }
    >
  >;
  readonly chats: Readonly<
    Record<
      keyof typeof CHATS,
      {
        readonly sessionId: string;
        readonly title: string;
        readonly linkedPageIds: readonly string[];
        readonly expectedStatusOptionId: WorkflowStatus | null;
        readonly pinned: boolean;
      }
    >
  >;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const isStatus = (value: unknown): value is WorkflowStatus | null =>
  value === null || isWorkflowStatus(value);

export const requireSidebarLinkedPageStatusScenarioFacts = (
  value: unknown,
): SidebarLinkedPageStatusScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  if (
    envelope.scenarioId !== SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_ID ||
    envelope.scenarioRevision !== SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_REVISION ||
    !isRecord(value) ||
    !isRecord(value.pages) ||
    !isRecord(value.chats)
  ) {
    throw new Error("sidebar/linked-page-status facts identity is invalid");
  }
  const { pages, chats } = value;
  const validPages = Object.keys(PAGE_TITLES).every((key) => {
    const page = pages[key];
    return (
      isRecord(page) &&
      isIdentity(page.pageId) &&
      isIdentity(page.title) &&
      isStatus(page.statusOptionId)
    );
  });
  const validChats = Object.keys(CHATS).every((key) => {
    const chat = chats[key];
    return (
      isRecord(chat) &&
      isIdentity(chat.sessionId) &&
      isIdentity(chat.title) &&
      Array.isArray(chat.linkedPageIds) &&
      chat.linkedPageIds.every(isIdentity) &&
      isStatus(chat.expectedStatusOptionId) &&
      typeof chat.pinned === "boolean"
    );
  });
  if (!validPages || !validChats) throw new Error("sidebar/linked-page-status facts are invalid");
  return value as unknown as SidebarLinkedPageStatusScenarioFacts;
};

const requireId = (ids: Readonly<Record<string, string>>, key: string): string => {
  const id = ids[key];
  if (id) return id;
  throw new Error(`sidebar/linked-page-status manifest has no ${key}`);
};

const materialize = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({ name: "Search and Navigation", sources: [workspace] });
  if (!project.defaultDatabaseViewId) {
    throw new Error("sidebar/linked-page-status Project has no default Database View");
  }
  const pageIdsByKey = Object.fromEntries(
    Object.keys(PAGE_TITLES).map((key) => [key, createUuidV7()]),
  );
  for (const status of WORKFLOW_STATUS_ORDER) {
    await port.createPage({
      key: status,
      pageId: requireId(pageIdsByKey, status),
      operationId: createUuidV7(),
      projectId: project.id,
      status,
      title: PAGE_TITLES[status],
      markdown: "",
    });
  }
  await port.createStandalonePage({
    pageId: requireId(pageIdsByKey, "noStatus"),
    documentId: createUuidV7(),
    operationId: createUuidV7(),
    projectId: project.id,
    title: PAGE_TITLES.noStatus,
  });
  const entityIdsByKey: Record<string, string> = {};
  for (const [key, recipe] of Object.entries(CHATS)) {
    const chat = await port.createRelatedChat({
      projectId: project.id,
      initialPageIds: recipe.pageKeys.map((pageKey) => requireId(pageIdsByKey, pageKey)),
      noThreadFallbackTitle: recipe.title,
      pinned: recipe.pinned,
    });
    entityIdsByKey[key] = chat.sessionId;
  }
  return {
    version: 1,
    scenarioId: SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_ID,
    scenarioRevision: SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey,
    entityIdsByKey,
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
};

const inspect = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<SidebarLinkedPageStatusScenarioFacts> => {
  const pages = await Promise.all(
    Object.entries(PAGE_TITLES).map(async ([key, title]) => {
      const pageId = requireId(manifest.pageIdsByKey, key);
      const [page, chats] = await Promise.all([
        port.readPage(manifest.projectId, pageId),
        port.readPageChats(pageId),
      ]);
      if (page.title !== title || page.documentReadiness !== "ready" || chats.hasMore) {
        throw new Error(`sidebar/linked-page-status Page ${key} did not materialize`);
      }
      return { key, pageId, title, chats: chats.items };
    }),
  );
  const board = await port.readBoard(manifest.projectId, manifest.databaseViewId);
  if (board.totalRows !== 5 || WORKFLOW_STATUS_ORDER.some((status) => board.groups[status] !== 1)) {
    throw new Error("sidebar/linked-page-status workflow Pages did not materialize");
  }
  const chats = Object.entries(CHATS).map(([key, recipe]) => {
    const sessionId = requireId(manifest.entityIdsByKey ?? {}, key);
    const linkedPages = pages.filter((page) =>
      page.chats.some((chat) => chat.sessionId === sessionId),
    );
    const expectedPageIds = recipe.pageKeys.map((pageKey) =>
      requireId(manifest.pageIdsByKey, pageKey),
    );
    const relatedChats = linkedPages.flatMap((page) =>
      page.chats.filter((chat) => chat.sessionId === sessionId),
    );
    if (
      linkedPages.length !== expectedPageIds.length ||
      linkedPages.some((page) => !expectedPageIds.includes(page.pageId)) ||
      relatedChats.some(
        (chat) => chat.displayTitle !== recipe.title || chat.threadId !== null || chat.unread,
      )
    ) {
      throw new Error(`sidebar/linked-page-status Chat ${key} did not materialize`);
    }
    return [
      key,
      {
        sessionId,
        title: recipe.title,
        linkedPageIds: linkedPages.map((page) => page.pageId),
        expectedStatusOptionId: recipe.expectedStatusOptionId,
        pinned: recipe.pinned,
      },
    ];
  });
  return requireSidebarLinkedPageStatusScenarioFacts({
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    pages: Object.fromEntries(
      pages.map(({ key, pageId, title }) => [
        key,
        { pageId, title, statusOptionId: isWorkflowStatus(key) ? key : null },
      ]),
    ),
    chats: Object.fromEntries(chats),
  });
};

export const sidebarLinkedPageStatusScenario: ScenarioDomainRecipe = {
  id: SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_ID,
  revision: SIDEBAR_LINKED_PAGE_STATUS_SCENARIO_REVISION,
  materialize,
  inspect,
  parseFacts: requireSidebarLinkedPageStatusScenarioFacts,
};
