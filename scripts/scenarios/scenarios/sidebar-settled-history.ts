import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const SIDEBAR_SETTLED_HISTORY_SCENARIO_ID = "sidebar/settled-history" as const;
const REVISION = 1;

const PROJECTS = { nodex: "Nodex", core: "Core", web: "Web" } as const;
type ProjectKey = keyof typeof PROJECTS;
const PROJECT_KEYS = Object.keys(PROJECTS) as ProjectKey[];

const ACTIONS = [
  "Fix",
  "Review",
  "Document",
  "Measure",
  "Refactor",
  "Trim",
  "Audit",
  "Plan",
] as const;
const AREAS = [
  "the sign-in redirect",
  "the Inbox query",
  "the backup restore",
  "keyboard navigation",
  "the release notes",
  "the dashboard bundle",
  "the sync retry",
  "the search index",
] as const;

/**
 * Settled chats, newest settlement first: more than one window of Core's chat list and more than
 * the sidebar's shelf reveals, so both read past their first rows to reach the end.
 */
export const SIDEBAR_SETTLED_HISTORY_CHATS = ACTIONS.flatMap((action, actionIndex) =>
  AREAS.map((area, areaIndex) => {
    const index = actionIndex * AREAS.length + areaIndex;
    return {
      key: `settled${String(index + 1).padStart(2, "0")}`,
      title: `${action} ${area}`,
      preview: `${action} ${area} and tell me what you changed and why.`,
      // Every seventh chat lives outside a Project.
      project: index % 7 === 6 ? null : PROJECT_KEYS[index % PROJECT_KEYS.length]!,
    };
  }),
);
export const SIDEBAR_SETTLED_HISTORY_OPEN_CHATS = [
  { key: "openNodex", title: "Ship the settled page", project: "nodex" },
  { key: "openCore", title: "Profile the task window count", project: "core" },
] as const;

interface SidebarSettledHistoryFacts extends ScenarioFacts {
  /** Settled chat Session ids, most recently settled first. */
  readonly settledSessionIds: readonly string[];
  readonly projectIds: Readonly<Record<ProjectKey, string>>;
}

export function requireSidebarSettledHistoryFacts(value: unknown): SidebarSettledHistoryFacts {
  const facts = parseScenarioFacts(value) as Partial<SidebarSettledHistoryFacts>;
  if (
    facts.scenarioId !== SIDEBAR_SETTLED_HISTORY_SCENARIO_ID ||
    facts.scenarioRevision !== REVISION ||
    !Array.isArray(facts.settledSessionIds) ||
    facts.settledSessionIds.length !== SIDEBAR_SETTLED_HISTORY_CHATS.length ||
    !facts.projectIds ||
    PROJECT_KEYS.some((key) => typeof facts.projectIds?.[key] !== "string")
  ) {
    throw new Error("Invalid sidebar/settled-history facts");
  }
  return facts as SidebarSettledHistoryFacts;
}

function requireEntity(manifest: ScenarioManifest, key: string): string {
  const id = manifest.entityIdsByKey?.[key];
  if (!id) throw new Error(`sidebar/settled-history is missing ${key}`);
  return id;
}

async function materialize(port: ScenarioSeedPort, workspace: string): Promise<ScenarioManifest> {
  if (!port.settleSessions) throw new Error("sidebar/settled-history needs Core seeding");
  const created = {
    nodex: await port.createProject({ name: PROJECTS.nodex, sources: [workspace] }),
    core: await port.createProject({ name: PROJECTS.core, sources: [workspace] }),
    web: await port.createProject({ name: PROJECTS.web, sources: [workspace] }),
  };
  if (!created.nodex.defaultDatabaseViewId) throw new Error("Nodex has no default Database View");
  const entityIdsByKey: Record<string, string> = Object.fromEntries(
    PROJECT_KEYS.map((key) => [key, created[key].id]),
  );
  const createChat = async (recipe: {
    readonly title: string;
    readonly preview: string;
    readonly project: ProjectKey | null;
  }) =>
    await port.createRelatedChat({
      projectId: recipe.project === null ? null : created[recipe.project].id,
      noThreadFallbackTitle: recipe.title,
      relatedPageIds: [],
      thread: {
        threadId: createUuidV7(),
        threadName: recipe.title,
        threadPreview: recipe.preview,
        statusType: "idle",
        statusActiveFlags: [],
        unread: false,
      },
    });
  for (const recipe of SIDEBAR_SETTLED_HISTORY_CHATS) {
    entityIdsByKey[recipe.key] = (await createChat(recipe)).sessionId;
  }
  for (const recipe of SIDEBAR_SETTLED_HISTORY_OPEN_CHATS) {
    entityIdsByKey[recipe.key] = (
      await createChat({ ...recipe, preview: `${recipe.title}, then report back.` })
    ).sessionId;
  }
  // One at a time from the oldest, so each chat settles after the one listed below it.
  for (const recipe of SIDEBAR_SETTLED_HISTORY_CHATS.toReversed()) {
    await port.settleSessions([entityIdsByKey[recipe.key]!]);
  }
  return {
    version: 1,
    scenarioId: SIDEBAR_SETTLED_HISTORY_SCENARIO_ID,
    scenarioRevision: REVISION,
    projectId: created.nodex.id,
    databaseViewId: created.nodex.defaultDatabaseViewId,
    pageIdsByKey: {},
    entityIdsByKey,
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
}

async function inspect(
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<SidebarSettledHistoryFacts> {
  const settledSessionIds: string[] = [];
  for (const recipe of SIDEBAR_SETTLED_HISTORY_CHATS) {
    const sessionId = requireEntity(manifest, recipe.key);
    const session = await port.readSession(sessionId);
    if (
      !session ||
      session.displayTitle !== recipe.title ||
      session.projectId !==
        (recipe.project === null ? null : requireEntity(manifest, recipe.project)) ||
      session.archived ||
      session.settledAt == null
    ) {
      throw new Error(`sidebar/settled-history chat ${recipe.key} is not settled as seeded`);
    }
    settledSessionIds.push(sessionId);
  }
  for (const recipe of SIDEBAR_SETTLED_HISTORY_OPEN_CHATS) {
    const session = await port.readSession(requireEntity(manifest, recipe.key));
    if (!session || session.settledAt != null || session.archived) {
      throw new Error(`sidebar/settled-history chat ${recipe.key} is not open`);
    }
  }
  return {
    scenarioId: SIDEBAR_SETTLED_HISTORY_SCENARIO_ID,
    scenarioRevision: REVISION,
    settledSessionIds,
    projectIds: {
      nodex: requireEntity(manifest, "nodex"),
      core: requireEntity(manifest, "core"),
      web: requireEntity(manifest, "web"),
    },
  };
}

export const sidebarSettledHistoryScenario: ScenarioDomainRecipe = {
  id: SIDEBAR_SETTLED_HISTORY_SCENARIO_ID,
  revision: REVISION,
  materialize,
  inspect,
  parseFacts: requireSidebarSettledHistoryFacts,
};
