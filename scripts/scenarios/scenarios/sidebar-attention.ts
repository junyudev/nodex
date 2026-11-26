import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioRelatedChatSeed,
  type ScenarioSeedPort,
} from "../contracts";

export const SIDEBAR_ATTENTION_SCENARIO_ID = "sidebar/attention" as const;
const REVISION = 2;
const PROJECTS = { nodex: "Nodex", core: "Core", web: "Web" } as const;
type ProjectKey = keyof typeof PROJECTS;
type ChatRecipe = {
  readonly project: ProjectKey | null;
  readonly title: string;
  readonly flags?: readonly ("waitingOnUserInput" | "waitingOnApproval")[];
  readonly turn?: "question" | "review";
  readonly unread?: true;
  readonly section?: true;
  /** When a snoozed chat returns, from the moment it is seeded; `due` has already returned. */
  readonly snooze?: SnoozeReturn | "due";
  readonly settled?: true;
  readonly pinned?: true;
};

type SnoozeReturn = "in-2-hours" | "tomorrow-morning" | "in-4-days" | "in-3-weeks";

function snoozeReturn(when: SnoozeReturn, now: Date): Date {
  if (when === "in-2-hours") return new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const days = when === "tomorrow-morning" ? 1 : when === "in-4-days" ? 4 : 21;
  const at = new Date(now);
  at.setDate(at.getDate() + days);
  at.setHours(9, 0, 0, 0);
  return at;
}

// The native waiting flags drive the Active rows. The Inbox question uses a local Session
// so Desktop's observer does not replace the seeded request with a native Thread snapshot.
function usesNativeThread(recipe: ChatRecipe): boolean {
  return !recipe.unread && recipe.snooze !== "due" && recipe.turn !== "question";
}
export const SIDEBAR_ATTENTION_CHATS = {
  pinned: { project: "nodex", title: "Release checklist", pinned: true },
  question: { project: "core", title: "Choose migration retention", flags: ["waitingOnUserInput"] },
  approval: { project: "nodex", title: "Publish the nightly build", flags: ["waitingOnApproval"] },
  unreadWeb: { project: "web", title: "Audit the sign-in redirects", unread: true },
  unreadProjectless: { project: null, title: "Summarize the design feedback", unread: true },
  quietNodex: { project: "nodex", title: "Tighten keyboard navigation" },
  quietCore: { project: "core", title: "Document the transaction boundary" },
  quietWeb: { project: "web", title: "Trim the dashboard bundle" },
  review: { project: "web", title: "Fix login race", turn: "review" },
  workingCore: { project: "core", title: "Measure Inbox query cost", flags: [] },
  workingProjectless: { project: null, title: "Compare icon export settings", flags: [] },
  releaseCore: {
    project: "core",
    title: "Confirm the rollback checklist",
    section: true,
    turn: "question",
  },
  releaseNodex: { project: "nodex", title: "Prepare the release checklist", section: true },
  snoozedSoon: { project: "nodex", title: "Rerun the flaky upload test", snooze: "in-2-hours" },
  snoozed: { project: "web", title: "Check the analytics rollout", snooze: "tomorrow-morning" },
  snoozedWeek: { project: "web", title: "Plan the onboarding refresh", snooze: "in-4-days" },
  snoozedMonth: { project: null, title: "Revisit the pricing page copy", snooze: "in-3-weeks" },
  woke: { project: "nodex", title: "Follow up on installer feedback", snooze: "due" },
  settledCore: { project: "core", title: "Verify the backup restore", settled: true },
  settledWeb: { project: "web", title: "Clean up unused routes", settled: true },
  settledProjectless: { project: null, title: "Compare the launch notes", settled: true },
} as const satisfies Readonly<Record<string, ChatRecipe>>;

interface SidebarAttentionFacts extends ScenarioFacts {
  readonly coreProjectId: string;
}

export function requireSidebarAttentionFacts(value: unknown): SidebarAttentionFacts {
  const facts = parseScenarioFacts(value);
  if (
    facts.scenarioId !== SIDEBAR_ATTENTION_SCENARIO_ID ||
    facts.scenarioRevision !== REVISION ||
    !("coreProjectId" in facts) ||
    typeof facts.coreProjectId !== "string" ||
    !facts.coreProjectId
  ) {
    throw new Error("Invalid sidebar/attention facts");
  }
  return { ...facts, coreProjectId: facts.coreProjectId };
}

function requireEntity(manifest: ScenarioManifest, key: string): string {
  const id = manifest.entityIdsByKey?.[key];
  if (!id) throw new Error(`sidebar/attention is missing ${key}`);
  return id;
}

async function materialize(port: ScenarioSeedPort, workspace: string): Promise<ScenarioManifest> {
  if (!port.settleSessions || !port.deliverDueSessionSnooze) {
    throw new Error("sidebar/attention needs Core seeding");
  }

  const nodex = await port.createProject({ name: PROJECTS.nodex, sources: [workspace] });
  const core = await port.createProject({ name: PROJECTS.core, sources: [workspace] });
  const web = await port.createProject({ name: PROJECTS.web, sources: [workspace] });
  if (!nodex.defaultDatabaseViewId) throw new Error("Nodex has no default Database View");
  const projects = { nodex: nodex.id, core: core.id, web: web.id };
  const section = await port.createSidebarSection({ name: "Release" });

  const pageIdsByKey = {
    question: createUuidV7(),
    review: createUuidV7(),
    intake: (
      await port.sendInboxMessage(
        "Check whether the next backup rehearsal should cover profiles with expired snoozes.",
        { kind: "project", projectId: core.id },
      )
    ).pageId,
  };
  await port.createPage({
    key: "question",
    pageId: pageIdsByKey.question,
    operationId: createUuidV7(),
    projectId: core.id,
    status: "doing",
    title: SIDEBAR_ATTENTION_CHATS.releaseCore.title,
    markdown:
      "Decide how long to retain the previous migration snapshot after a successful upgrade.",
  });
  await port.createPage({
    key: "review",
    pageId: pageIdsByKey.review,
    operationId: createUuidV7(),
    projectId: web.id,
    status: "review",
    title: SIDEBAR_ATTENTION_CHATS.review.title,
    markdown:
      "Concurrent sign-ins now share the token refresh. Verify the expired-token retry before merging.",
  });
  const entityIdsByKey: Record<string, string> = { ...projects, releaseSection: section.sectionId };
  const settledIds: string[] = [];
  for (const [key, recipe] of Object.entries<ChatRecipe>(SIDEBAR_ATTENTION_CHATS)) {
    const linkedPage = recipe.turn ? pageIdsByKey[recipe.turn] : null;
    const thread: ScenarioRelatedChatSeed["thread"] = usesNativeThread(recipe)
      ? {
          threadId: createUuidV7(),
          threadName: recipe.title,
          threadPreview: "",
          statusType: recipe.flags ? "active" : "idle",
          statusActiveFlags: recipe.flags ?? [],
          unread: false,
        }
      : undefined;
    const chat = await port.createRelatedChat({
      projectId: recipe.project === null ? null : projects[recipe.project],
      noThreadFallbackTitle: recipe.title,
      relatedPageIds: linkedPage === null ? [] : [linkedPage],
      ...(linkedPage ? { handOff: true } : {}),
      ...(recipe.pinned ? { pinned: true } : {}),
      ...(thread ? { thread } : {}),
    });
    entityIdsByKey[key] = chat.sessionId;
    if (recipe.unread) await port.setSessionUnread(chat.sessionId, true);
    if (recipe.settled) settledIds.push(chat.sessionId);
    if (recipe.section) {
      await port.moveSidebarSectionItem({
        item: { kind: "session", sessionId: chat.sessionId },
        sectionId: section.sectionId,
        placement: { kind: "end" },
      });
    }
    if (recipe.snooze && recipe.snooze !== "due") {
      const returnsAt = snoozeReturn(recipe.snooze, new Date());
      await port.setSessionSnooze(chat.sessionId, returnsAt.toISOString());
    }
    if (recipe.snooze === "due") {
      await port.setSessionSnooze(chat.sessionId, new Date(Date.now() - 60_000).toISOString());
      await port.deliverDueSessionSnooze(chat.sessionId);
    }
  }
  await port.settleSessions(settledIds);
  const now = Date.now();
  const requestId = createUuidV7();
  const questionSession = entityIdsByKey.releaseCore;
  if (!questionSession) throw new Error("sidebar/attention has no question Session");
  await port.recordSessionExecution(questionSession, {
    state: "waiting",
    runId: createUuidV7(),
    runStartedAt: now,
    pendingRequestIds: [requestId],
    pendingRequests: [
      {
        id: requestId,
        kind: "question",
        question: "Which backup should the checklist use for rollback?",
        options: ["Pre-migration snapshot", "Last nightly backup"],
      },
    ],
    queue: null,
    terminalStatus: null,
    personStopped: false,
    stalled: false,
    progressFingerprint: null,
    progressSince: now,
  });

  return {
    version: 1,
    scenarioId: SIDEBAR_ATTENTION_SCENARIO_ID,
    scenarioRevision: REVISION,
    projectId: nodex.id,
    databaseViewId: nodex.defaultDatabaseViewId,
    pageIdsByKey,
    entityIdsByKey,
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
}

async function inspect(
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<SidebarAttentionFacts> {
  for (const [key, recipe] of Object.entries<ChatRecipe>(SIDEBAR_ATTENTION_CHATS)) {
    const session = await port.readSession(requireEntity(manifest, key));
    const expectedTurn = recipe.turn;
    if (
      !session ||
      session.displayTitle !== recipe.title ||
      session.projectId !==
        (recipe.project === null ? null : requireEntity(manifest, recipe.project)) ||
      session.archived ||
      session.pinned !== Boolean(recipe.pinned) ||
      session.unread !== Boolean(recipe.unread || recipe.snooze === "due") ||
      (session.settledAt != null) !== Boolean(recipe.settled) ||
      Boolean(session.snoozedUntil) !== Boolean(recipe.snooze && recipe.snooze !== "due") ||
      (session.wokeAt != null) !== (recipe.snooze === "due") ||
      session.pageTurn?.reason !== expectedTurn ||
      (expectedTurn && session.pageTurn?.page_id !== manifest.pageIdsByKey[expectedTurn])
    ) {
      throw new Error(`sidebar/attention chat ${key} has unexpected state`);
    }
    if (
      usesNativeThread(recipe) &&
      (session.thread?.statusType !== (recipe.flags ? "active" : "idle") ||
        (recipe.flags && recipe.flags.join(",") !== session.thread.statusActiveFlags.join(",")))
    ) {
      throw new Error(`sidebar/attention chat ${key} has unexpected execution status`);
    }
  }
  const section = await port.listSidebarSectionItems(requireEntity(manifest, "releaseSection"));
  const releaseIds = section.items.flatMap((item) =>
    item.kind === "session" ? [item.session.id] : [],
  );
  if (
    releaseIds.join(",") !==
    ["releaseCore", "releaseNodex"].map((key) => requireEntity(manifest, key)).join(",")
  ) {
    throw new Error("sidebar/attention Release Section must hold its two direct chats");
  }

  const coreProjectId = requireEntity(manifest, "core");
  const coreInbox = (await port.readInbox({ kind: "project", projectId: coreProjectId })).items;
  const webInbox = (
    await port.readInbox({ kind: "project", projectId: requireEntity(manifest, "web") })
  ).items;
  if (
    coreInbox.length !== 2 ||
    !coreInbox.some(
      (item) => item.pageId === manifest.pageIdsByKey.intake && item.rowKind === "intake",
    ) ||
    !coreInbox.some(
      (item) =>
        item.pageId === manifest.pageIdsByKey.question && item.turn?.turn.reason === "question",
    ) ||
    webInbox.length !== 1 ||
    webInbox[0]?.pageId !== manifest.pageIdsByKey.review ||
    webInbox[0]?.turn?.turn.reason !== "review"
  ) {
    const describe = (items: typeof coreInbox) =>
      items.map((item) => `${item.turn?.turn.reason ?? item.rowKind} (${item.title})`).join(", ");
    throw new Error(
      `sidebar/attention expected Core intake and question and Web review. Core has [${describe(coreInbox)}], Web has [${describe(webInbox)}]`,
    );
  }
  return {
    scenarioId: SIDEBAR_ATTENTION_SCENARIO_ID,
    scenarioRevision: REVISION,
    coreProjectId,
  };
}

export const sidebarAttentionScenario: ScenarioDomainRecipe = {
  id: SIDEBAR_ATTENTION_SCENARIO_ID,
  revision: REVISION,
  materialize,
  inspect,
  parseFacts: requireSidebarAttentionFacts,
};
