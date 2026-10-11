import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const INBOX_TRIAGE_SCENARIO_ID = "inbox/triage" as const;
export const INBOX_TRIAGE_SCENARIO_REVISION = 1 as const;

const PAGE_KEYS = {
  kept: "keptNote",
  newChat: "newChatSuggestion",
  sendToChat: "sendToChatSuggestion",
  move: "moveSuggestion",
  dispatched: "dispatchedMessage",
  failed: "failedSuggestion",
} as const;
const WORKING_SESSION_KEY = "workingSession";
const WORKING_THREAD_KEY = "workingThread";

export interface InboxTriageScenarioFacts extends ScenarioFacts {
  readonly entryCount: number;
  readonly inboxCount: number;
  readonly needsDecisionCount: number;
  readonly keptCount: number;
  readonly dispatchedCount: number;
  readonly failedSuggestionCount: number;
}

export const requireInboxTriageScenarioFacts = (value: unknown): InboxTriageScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  const candidate = value as Record<string, unknown>;
  if (
    envelope.scenarioId !== INBOX_TRIAGE_SCENARIO_ID ||
    envelope.scenarioRevision !== INBOX_TRIAGE_SCENARIO_REVISION ||
    ![
      "entryCount",
      "inboxCount",
      "needsDecisionCount",
      "keptCount",
      "dispatchedCount",
      "failedSuggestionCount",
    ].every((key) => typeof candidate[key] === "number")
  ) {
    throw new Error("inbox/triage facts are invalid");
  }
  return value as InboxTriageScenarioFacts;
};

/**
 * Every Inbox reply state in one stream, without anything left for a live Agent to do: each
 * message is already suggested, kept, delivered, or failed.
 */
const materializeInboxTriage = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({ name: "Nodex", sources: [workspace] });
  if (!project.defaultDatabaseViewId) throw new Error("inbox/triage Project has no default View");
  const workingThreadId = createUuidV7();
  const working = await port.createRelatedChat({
    projectId: project.id,
    initialPageIds: [],
    noThreadFallbackTitle: "Sidebar polish",
    thread: {
      threadId: workingThreadId,
      threadName: "Sidebar polish",
      threadPreview: "Tightening sidebar row spacing and hover states",
      statusType: "active",
      statusActiveFlags: [],
      unread: false,
    },
  });

  const kept = await port.sendInboxMessage(
    "The Linear changelog layout is lovely — denser than ours, and the dates read at a glance.",
  );
  await port.proposeInboxDispatch({
    pageIds: [kept.pageId],
    action: { type: "keep" },
    kind: "note",
    summary: "Keep this as a design reference.",
    rationale: "An observation, not a request for work.",
  });
  await port.keepInboxEntries([kept.pageId]);

  const dispatched = await port.sendInboxMessage(
    "Research how three other assistants onboard new users.\nI want a one-page comparison, not code.",
  );
  await port.dispatchInboxEntries({
    pageIds: [dispatched.pageId],
    action: {
      type: "send_to_chat",
      sessionId: working.sessionId,
      prompt: "Compare three assistant onboarding flows in one page. Do not change code.",
    },
  });
  // A confirmed dispatch is handled, so it is already in History.
  const delivered = (await port.readInbox("processed")).items.find(
    (item) => item.pageId === dispatched.pageId,
  )?.proposal;
  if (!delivered) throw new Error("inbox/triage dispatched message has no proposal");
  await port.completeInboxDispatch(delivered.proposalId, workingThreadId);

  const newChat = await port.sendInboxMessage(
    "Homepage feels like a dev tool. Maybe it should read like a personal assistant?",
  );
  await port.proposeInboxDispatch({
    pageIds: [newChat.pageId],
    action: {
      type: "new_chat",
      projectId: project.id,
      prompt:
        "Compare positioning the homepage as a developer tool versus a personal assistant. Read the current homepage and notes, then deliver a short comparison and the decisions I need to make. Do not change code.",
    },
    kind: "question",
    summary: "Compare both homepage positions before changing anything.",
    rationale: "This is an open question; research first, decide later.",
  });

  const sendToChat = await port.sendInboxMessage("Project rows flicker on hover in the sidebar.");
  await port.proposeInboxDispatch({
    pageIds: [sendToChat.pageId],
    action: {
      type: "send_to_chat",
      sessionId: working.sessionId,
      prompt: "Also fix the hover flicker on Project rows in the sidebar.",
    },
    kind: "todo",
    summary: "Add the hover flicker to the sidebar polish chat.",
    rationale: "It continues the sidebar work already in progress.",
  });

  const move = await port.sendInboxMessage("Document ⇧⌘D in the keyboard shortcuts reference.");
  await port.proposeInboxDispatch({
    pageIds: [move.pageId],
    action: { type: "move_to_project", projectId: project.id },
    kind: "todo",
    summary: "File this as a Nodex task for later.",
    rationale: "Concrete, small, and not urgent.",
  });

  const failed = await port.sendInboxMessage("Should Telegram become an Inbox source?");
  await port.recordInboxSuggestionFailure([failed.pageId], "The suggestion model is unavailable");

  return {
    version: 1,
    scenarioId: INBOX_TRIAGE_SCENARIO_ID,
    scenarioRevision: INBOX_TRIAGE_SCENARIO_REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey: {
      [PAGE_KEYS.kept]: kept.pageId,
      [PAGE_KEYS.dispatched]: dispatched.pageId,
      [PAGE_KEYS.newChat]: newChat.pageId,
      [PAGE_KEYS.sendToChat]: sendToChat.pageId,
      [PAGE_KEYS.move]: move.pageId,
      [PAGE_KEYS.failed]: failed.pageId,
    },
    entityIdsByKey: {
      [WORKING_SESSION_KEY]: working.sessionId,
      [WORKING_THREAD_KEY]: workingThreadId,
    },
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
};

const inspectInboxTriage = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<InboxTriageScenarioFacts> => {
  const inbox = (await port.readInbox("inbox")).items;
  const items = [...inbox, ...(await port.readInbox("processed")).items];
  const facts: InboxTriageScenarioFacts = {
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    entryCount: items.length,
    inboxCount: inbox.length,
    needsDecisionCount: items.filter(
      (item) => item.state === "open" && item.proposal?.state === "open",
    ).length,
    keptCount: items.filter((item) => item.state === "kept").length,
    dispatchedCount: items.filter((item) => item.proposal?.state === "completed").length,
    failedSuggestionCount: items.filter((item) => item.suggestionState === "failed").length,
  };
  if (
    facts.entryCount !== 6 ||
    facts.inboxCount !== 4 ||
    facts.needsDecisionCount !== 3 ||
    facts.keptCount !== 1 ||
    facts.dispatchedCount !== 1 ||
    facts.failedSuggestionCount !== 1
  ) {
    throw new Error(
      `inbox/triage materialized facts do not match revision ${INBOX_TRIAGE_SCENARIO_REVISION}`,
    );
  }
  return facts;
};

export const inboxTriageScenario: ScenarioDomainRecipe = {
  id: INBOX_TRIAGE_SCENARIO_ID,
  revision: INBOX_TRIAGE_SCENARIO_REVISION,
  materialize: materializeInboxTriage,
  inspect: inspectInboxTriage,
  parseFacts: requireInboxTriageScenarioFacts,
};
