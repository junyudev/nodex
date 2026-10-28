import { agentRuntimeProviderId } from "../../../src/shared/agent-runtime-provider";
import { defaultClaudeInstance } from "../../../src/shared/claude-agent-settings";
import {
  parseDataSourceOptionId,
  type DataSourceId,
} from "../../../src/shared/database-identities";
import { projectInbox, type InboxScope } from "../../../src/shared/inbox";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const INBOX_TRIAGE_SCENARIO_ID = "inbox/triage" as const;
export const INBOX_TRIAGE_SCENARIO_REVISION = 5 as const;
/** The Claude Code account every Profile starts with. */
const DEFAULT_CLAUDE_INSTANCE_ID = agentRuntimeProviderId({
  kind: "claude",
  instanceConfigId: defaultClaudeInstance().id,
})!;

const PAGE_KEYS = {
  kept: "keptNote",
  newChat: "newChatSuggestion",
  sendToChat: "sendToChatSuggestion",
  move: "moveSuggestion",
  dispatched: "dispatchedMessage",
  failed: "failedSuggestion",
  pictured: "picturedMessage",
  projectNewChat: "projectNewChatSuggestion",
  projectSendToChat: "projectSendToChatSuggestion",
  projectMove: "projectMoveSuggestion",
  inboxMovedWithChat: "inboxMovedWithChat",
  inboxMovedNoChat: "inboxMovedNoChat",
  inboxTriageTwoChats: "inboxTriageTwoChats",
  inboxTriageOneIdleChat: "inboxTriageOneIdleChat",
  inboxPlainTriage: "inboxPlainTriage",
  libraryInboxMovedWithChat: "libraryInboxMovedWithChat",
} as const;
const WORKING_SESSION_KEY = "workingSession";
const WORKING_THREAD_KEY = "workingThread";
const WEBSITE_PROJECT_KEY = "websiteProject";
const SCREENSHOT_FILE_KEY = "screenshotFile";
const CHAT_KEYS = {
  moved: "inboxMovedWorkingSession",
  idle: "inboxTriageIdleSession",
  waiting: "inboxTriageWaitingSession",
  single: "inboxSingleIdleSession",
} as const;
// A 192 by 96 PNG, enough for a thumbnail to show its real pixels.
const SCREENSHOT_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAMAAAABgCAIAAADEouq+AAABBklEQVR4nO3SQQkAIADAQMMaxzgGtIN7iHBwAfbYmGvDtfG8gK8ZiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEYiASA5EYiMRAJAYiMRCJgUgMRGIgEgORGIjEQCQGIjEQiYFIDERiIBIDkRiIxEAkBiIxEImBSAxEcgBRsybr72+iHwAAAABJRU5ErkJggg==",
    "base64",
  ),
);

interface InboxTriageMessageFacts {
  readonly pageId: string;
  readonly sessionIds: readonly string[];
}

export interface InboxTriageScenarioFacts extends ScenarioFacts {
  readonly entryCount: number;
  readonly inboxCount: number;
  readonly needsDecisionCount: number;
  readonly keptCount: number;
  readonly dispatchedCount: number;
  readonly failedSuggestionCount: number;
  /** Messages waiting in the Nodex Project's own Inbox. */
  readonly projectInboxCount: number;
  readonly inboxMovedWithChat: InboxTriageMessageFacts;
  readonly inboxMovedNoChat: InboxTriageMessageFacts;
  readonly inboxTriageTwoChats: InboxTriageMessageFacts;
  readonly inboxTriageOneIdleChat: InboxTriageMessageFacts;
  readonly inboxPlainTriage: InboxTriageMessageFacts;
  readonly libraryInboxMovedWithChat: InboxTriageMessageFacts;
}

const isMessageFacts = (value: unknown): value is InboxTriageMessageFacts => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pageId === "string" &&
    candidate.pageId.length > 0 &&
    Array.isArray(candidate.sessionIds) &&
    candidate.sessionIds.every((sessionId) => typeof sessionId === "string" && sessionId.length > 0)
  );
};

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
      "projectInboxCount",
    ].every((key) => typeof candidate[key] === "number") ||
    ![
      "inboxMovedWithChat",
      "inboxMovedNoChat",
      "inboxTriageTwoChats",
      "inboxTriageOneIdleChat",
      "inboxPlainTriage",
      "libraryInboxMovedWithChat",
    ].every((key) => isMessageFacts(candidate[key]))
  ) {
    throw new Error("inbox/triage facts are invalid");
  }
  return value as InboxTriageScenarioFacts;
};

const requireSuccess = <Value>(
  result:
    | { readonly ok: true; readonly value: Value }
    | { readonly ok: false; readonly error: { readonly message: string } },
): Value => {
  if (result.ok) return result.value;
  throw new Error(`inbox/triage seed failed: ${result.error.message}`);
};

const captureOpenNote = async (port: ScenarioSeedPort, body: string, scope?: InboxScope) => {
  const message = await port.sendInboxMessage(body, scope);
  // Advice settles suggestion work; only confirming it would handle the message.
  await port.proposeInboxDispatch({
    pageIds: [message.pageId],
    action: { type: "keep" },
    kind: "note",
    summary: "Keep this note for later.",
    rationale: null,
  });
  return message;
};

const setInboxPageStatus = async (
  port: ScenarioSeedPort,
  projectId: string,
  pageId: string,
  dataSourceId: DataSourceId,
  status: "build" | "review",
) => {
  const snapshot = requireSuccess(
    await port.readDatabase({
      projectId,
      read: { target: { kind: "data_source", dataSourceId }, mode: "data_source" },
    }),
  );
  if (snapshot.value.kind !== "data_source") throw new Error("inbox/triage expected a Data Source");
  const property = snapshot.value.value.properties.find(
    (item) =>
      item.systemRole === "status" && item.lifecycle === "active" && item.schema.kind === "select",
  );
  if (!property) throw new Error("inbox/triage Inbox has no Status property");
  requireSuccess(
    await port.applyDatabase({
      projectId,
      storeEpoch: snapshot.storeEpoch,
      operationId: createUuidV7(),
      actor: { kind: "scenario_seed" },
      operations: [
        {
          kind: "edit_property_values",
          edits: [
            {
              pageId,
              dataSourceId,
              propertyId: property.propertyId,
              edit: {
                kind: "replace",
                // Capture initializes defaults, then commits the Inbox's Triage placement.
                expectedValueRevision: 2,
                value: {
                  kind: "select",
                  optionId: parseDataSourceOptionId({
                    propertyId: property.propertyId,
                    value: status,
                  }),
                },
              },
            },
          ],
        },
      ],
    }),
  );
};

/**
 * Every Inbox reply state in one stream, without anything left for a live Agent to do: each
 * message is already suggested, kept, delivered, or failed. New open messages also show Page
 * Status and linked Chat activity independently of whether an Inbox decision was confirmed.
 */
const materializeInboxTriage = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({ name: "Nodex", sources: [workspace] });
  if (!project.defaultDatabaseViewId) throw new Error("inbox/triage Project has no default View");
  const website = await port.createProject({ name: "Website", sources: [] });
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
      agent: null,
      delegates: [],
      plan: null,
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

  const screenshotFileId = createUuidV7();
  await port.createLibraryFile({
    projectId: project.id,
    operationId: createUuidV7(),
    fileId: screenshotFileId,
    defaultName: "settings-toolbar.png",
    mimeType: "image/png",
    bytes: SCREENSHOT_BYTES,
  });
  // Written as message text: formatting, a list, and a pasted screenshot after the text.
  const pictured = await port.sendInboxMessage(
    [
      "Settings buttons have **no accessible labels**:",
      "",
      "- the gear in the toolbar",
      "- the close button on dialogs",
      "",
      `![Settings toolbar](nodex://files/${screenshotFileId})`,
    ].join("\n"),
  );
  await port.proposeInboxDispatch({
    pageIds: [pictured.pageId],
    action: {
      type: "send_to_chat",
      sessionId: working.sessionId,
      prompt: "Also give the toolbar gear and the dialog close buttons accessible labels.",
    },
    kind: "todo",
    summary: "Add the missing labels to the sidebar polish chat.",
    rationale: "Small accessibility fixes on surfaces already in progress.",
  });

  const failed = await port.sendInboxMessage("Should Telegram become an Inbox source?");
  await port.recordInboxSuggestionFailure([failed.pageId], "The suggestion model is unavailable");

  const nodexInbox = projectInbox(project.id);
  const projectNewChat = await port.sendInboxMessage(
    "Board columns waste a lot of space on narrow windows.",
    nodexInbox,
  );
  await port.proposeInboxDispatch({
    pageIds: [projectNewChat.pageId],
    action: {
      type: "new_chat",
      projectId: project.id,
      prompt:
        "Make Board columns collapse gracefully on narrow windows. Keep the wide layout unchanged.",
      // A planned chat: interaction and visual work lead on Opus; the arithmetic goes to Codex.
      agent: {
        instanceId: DEFAULT_CLAUDE_INSTANCE_ID,
        model: "claude-opus-5-5",
        reasoningEffort: "high",
        serviceTier: null,
      },
      delegates: [
        {
          work: "Work out the column widths at each breakpoint and unit-test that layout arithmetic",
          agent: {
            instanceId: "codex",
            model: "gpt-6.1-sol",
            reasoningEffort: "xhigh",
            serviceTier: null,
          },
        },
      ],
      plan: "Design the narrow layout and its transitions yourself; keep the wide layout pixel-identical. Wire in the delegated arithmetic once its tests pass.",
    },
    kind: "todo",
    summary: "Start a chat to tighten narrow Board columns.",
    rationale: "A concrete layout fix inside this Project.",
  });

  const projectSendToChat = await port.sendInboxMessage(
    "Sidebar section headers should stick while scrolling.",
    nodexInbox,
  );
  await port.proposeInboxDispatch({
    pageIds: [projectSendToChat.pageId],
    action: {
      type: "send_to_chat",
      sessionId: working.sessionId,
      prompt: "Also keep sidebar section headers pinned while the list scrolls.",
    },
    kind: "todo",
    summary: "Add sticky headers to the sidebar polish chat.",
    rationale: "Same surface as the sidebar work already running.",
  });

  const projectMove = await port.sendInboxMessage(
    "The pricing page still calls the app a beta.",
    nodexInbox,
  );
  await port.proposeInboxDispatch({
    pageIds: [projectMove.pageId],
    action: { type: "move_to_project", projectId: website.id },
    kind: "todo",
    summary: "File this in Website.",
    rationale: "It is about the marketing site, not the app.",
  });

  const catalog = requireSuccess(
    await port.readDatabase({
      projectId: project.id,
      read: { target: { kind: "project_default" }, mode: "catalog_window", window: { first: 100 } },
    }),
  );
  if (catalog.value.kind !== "catalog_window")
    throw new Error("inbox/triage expected a Database catalog");
  const databases = catalog.value.value.databases;
  const projectSource = databases.find((item) =>
    item.views.some((view) => view.viewId === project.defaultDatabaseViewId),
  )?.dataSources[0];
  const librarySource = databases.find((item) => item.database.name === "Inbox")?.dataSources[0];
  if (!projectSource || !librarySource)
    throw new Error("inbox/triage Inbox Data Sources are missing");

  const movedNote = "Keep the drag handle visible while moving a block.";
  const libraryInboxMovedWithChat = await captureOpenNote(port, movedNote);
  const inboxMovedWithChat = await captureOpenNote(port, movedNote, nodexInbox);
  const inboxMovedNoChat = await captureOpenNote(
    port,
    "Review the empty search results copy.",
    nodexInbox,
  );
  const inboxPlainTriage = await captureOpenNote(
    port,
    "Try a quieter notification sound.",
    nodexInbox,
  );
  const inboxTriageTwoChats = await captureOpenNote(
    port,
    "Check keyboard focus after closing search.",
    nodexInbox,
  );
  const inboxTriageOneIdleChat = await captureOpenNote(
    port,
    "The export preview needs a final look.",
    nodexInbox,
  );

  await setInboxPageStatus(
    port,
    project.id,
    libraryInboxMovedWithChat.pageId,
    librarySource.dataSourceId,
    "build",
  );
  await setInboxPageStatus(
    port,
    project.id,
    inboxMovedWithChat.pageId,
    projectSource.dataSourceId,
    "build",
  );
  await setInboxPageStatus(
    port,
    project.id,
    inboxMovedNoChat.pageId,
    projectSource.dataSourceId,
    "review",
  );

  const movedChat = await port.createRelatedChat({
    projectId: project.id,
    initialPageIds: [inboxMovedWithChat.pageId, libraryInboxMovedWithChat.pageId],
    noThreadFallbackTitle: "Block drag handle",
    thread: {
      threadId: createUuidV7(),
      threadName: "Block drag handle",
      threadPreview: "Keeping the handle visible throughout a drag",
      statusType: "active",
      statusActiveFlags: [],
      unread: false,
    },
  });
  const idleChat = await port.createRelatedChat({
    projectId: project.id,
    initialPageIds: [inboxTriageTwoChats.pageId],
    noThreadFallbackTitle: "Search keyboard review",
    thread: {
      threadId: createUuidV7(),
      threadName: "Search keyboard review",
      threadPreview: "Reviewed the current focus behavior",
      statusType: "idle",
      statusActiveFlags: [],
      unread: false,
    },
  });
  const waitingChat = await port.createRelatedChat({
    projectId: project.id,
    initialPageIds: [inboxTriageTwoChats.pageId],
    noThreadFallbackTitle: "Search focus behavior",
    thread: {
      threadId: createUuidV7(),
      threadName: "Search focus behavior",
      threadPreview: "Should focus return to the search button?",
      statusType: "active",
      statusActiveFlags: ["waitingOnUserInput"],
      unread: false,
    },
  });
  const singleChat = await port.createRelatedChat({
    projectId: project.id,
    initialPageIds: [inboxTriageOneIdleChat.pageId],
    noThreadFallbackTitle: "Export preview review",
    thread: {
      threadId: createUuidV7(),
      threadName: "Export preview review",
      threadPreview: "The preview is ready for your review.",
      statusType: "idle",
      statusActiveFlags: [],
      unread: false,
    },
  });

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
      [PAGE_KEYS.pictured]: pictured.pageId,
      [PAGE_KEYS.projectNewChat]: projectNewChat.pageId,
      [PAGE_KEYS.projectSendToChat]: projectSendToChat.pageId,
      [PAGE_KEYS.projectMove]: projectMove.pageId,
      [PAGE_KEYS.inboxMovedWithChat]: inboxMovedWithChat.pageId,
      [PAGE_KEYS.inboxMovedNoChat]: inboxMovedNoChat.pageId,
      [PAGE_KEYS.inboxTriageTwoChats]: inboxTriageTwoChats.pageId,
      [PAGE_KEYS.inboxTriageOneIdleChat]: inboxTriageOneIdleChat.pageId,
      [PAGE_KEYS.inboxPlainTriage]: inboxPlainTriage.pageId,
      [PAGE_KEYS.libraryInboxMovedWithChat]: libraryInboxMovedWithChat.pageId,
    },
    entityIdsByKey: {
      [WORKING_SESSION_KEY]: working.sessionId,
      [WORKING_THREAD_KEY]: workingThreadId,
      [WEBSITE_PROJECT_KEY]: website.id,
      [SCREENSHOT_FILE_KEY]: screenshotFileId,
      [CHAT_KEYS.moved]: movedChat.sessionId,
      [CHAT_KEYS.idle]: idleChat.sessionId,
      [CHAT_KEYS.waiting]: waitingChat.sessionId,
      [CHAT_KEYS.single]: singleChat.sessionId,
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
  const projectScope = projectInbox(manifest.projectId);
  const projectItems = (await port.readInbox("inbox", projectScope)).items;
  const items = [...inbox, ...(await port.readInbox("processed")).items];
  const inspectOpenMessage = async (
    key: string,
    status: string,
    sessionKeys: readonly string[],
    expectedActivity: {
      readonly workingCount?: number;
      readonly waitingOnUserInputCount?: number;
    } = {},
    library = false,
  ): Promise<InboxTriageMessageFacts> => {
    const pageId = manifest.pageIdsByKey[key];
    if (!pageId) throw new Error(`inbox/triage manifest has no ${key}`);
    const sessionIds = sessionKeys.map((sessionKey) => {
      const sessionId = manifest.entityIdsByKey?.[sessionKey];
      if (!sessionId) throw new Error(`inbox/triage manifest has no ${sessionKey}`);
      return sessionId;
    });
    const item = (library ? inbox : projectItems).find((entry) => entry.pageId === pageId);
    const [chats, activity] = await Promise.all([
      port.readPageChats(pageId),
      port.readPageChatActivity([pageId]),
    ]);
    const summary = activity.summaries.find((entry) => entry.pageId === pageId);
    if (
      !item ||
      item.state !== "open" ||
      item.outcome !== null ||
      item.suggestionState !== "settled" ||
      item.proposal?.state !== "open" ||
      item.proposal.action.type !== "keep" ||
      item.pageStatus?.id !== status ||
      chats.items.length !== sessionIds.length ||
      !sessionIds.every((sessionId) => chats.items.some((chat) => chat.sessionId === sessionId)) ||
      !summary ||
      summary.relatedCount !== sessionIds.length ||
      summary.workingCount !== (expectedActivity.workingCount ?? 0) ||
      summary.waitingOnUserInputCount !== (expectedActivity.waitingOnUserInputCount ?? 0) ||
      summary.waitingOnApprovalCount !== 0 ||
      summary.errorCount !== 0 ||
      summary.unreadCount !== 0
    ) {
      throw new Error(
        `inbox/triage ${key} did not retain its open message, Status and linked Chats`,
      );
    }
    return { pageId, sessionIds };
  };
  const [
    inboxMovedWithChat,
    inboxMovedNoChat,
    inboxTriageTwoChats,
    inboxTriageOneIdleChat,
    inboxPlainTriage,
    libraryInboxMovedWithChat,
  ] = await Promise.all([
    inspectOpenMessage(PAGE_KEYS.inboxMovedWithChat, "build", [CHAT_KEYS.moved], {
      workingCount: 1,
    }),
    inspectOpenMessage(PAGE_KEYS.inboxMovedNoChat, "review", []),
    inspectOpenMessage(
      PAGE_KEYS.inboxTriageTwoChats,
      "triage",
      [CHAT_KEYS.idle, CHAT_KEYS.waiting],
      { waitingOnUserInputCount: 1 },
    ),
    inspectOpenMessage(PAGE_KEYS.inboxTriageOneIdleChat, "triage", [CHAT_KEYS.single]),
    inspectOpenMessage(PAGE_KEYS.inboxPlainTriage, "triage", []),
    inspectOpenMessage(
      PAGE_KEYS.libraryInboxMovedWithChat,
      "build",
      [CHAT_KEYS.moved],
      { workingCount: 1 },
      true,
    ),
  ]);
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
    projectInboxCount: projectItems.length,
    inboxMovedWithChat,
    inboxMovedNoChat,
    inboxTriageTwoChats,
    inboxTriageOneIdleChat,
    inboxPlainTriage,
    libraryInboxMovedWithChat,
  };
  if (
    facts.entryCount !== 8 ||
    facts.inboxCount !== 6 ||
    facts.needsDecisionCount !== 5 ||
    facts.keptCount !== 1 ||
    facts.dispatchedCount !== 1 ||
    facts.failedSuggestionCount !== 1 ||
    facts.projectInboxCount !== 8 ||
    projectItems
      .slice(0, 5)
      .map((item) => item.pageId)
      .join(",") !==
      [
        inboxTriageOneIdleChat.pageId,
        inboxTriageTwoChats.pageId,
        inboxPlainTriage.pageId,
        inboxMovedNoChat.pageId,
        inboxMovedWithChat.pageId,
      ].join(",")
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
