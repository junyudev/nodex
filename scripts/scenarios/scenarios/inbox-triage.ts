import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
export const INBOX_TRIAGE_SCENARIO_REVISION = 11 as const;
/** The Claude Code account every Profile starts with. */
const DEFAULT_CLAUDE_INSTANCE_ID = agentRuntimeProviderId({
  kind: "claude",
  instanceConfigId: defaultClaudeInstance().id,
})!;

const inboxTriageSkills = [
  { name: "positioning-review", reason: "Compare how the homepage speaks to each audience." },
  { name: "homepage-audit", reason: "Find the current claims and supporting evidence." },
];

export async function seedInboxTriageSkills(workspace: string) {
  await Promise.all(
    inboxTriageSkills.map(async ({ name, reason }) => {
      const directory = join(workspace, ".agents", "skills", name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${reason}\n---\n\nReview the Project notes and report findings.\n`,
      );
    }),
  );
}

const PAGE_KEYS = {
  laterTimed: "laterTimed",
  laterReturned: "laterReturned",
  laterSuggested: "laterSuggested",
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
  notesPage: "notesPage",
  notesSection: "notesSection",
  savedNote: "savedNote",
  waitingNote: "waitingNote",
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
  /** Retained intake messages across the Library and all Projects. */
  readonly entryCount: number;
  /** Mixed Inbox rows, including eligible Page Turns. */
  readonly inboxCount: number;
  readonly needsDecisionCount: number;
  readonly keptCount: number;
  readonly dispatchedCount: number;
  readonly failedSuggestionCount: number;
  /** Messages waiting in the Nodex Project's own Inbox. */
  readonly projectInboxCount: number;
  readonly notesPageId: string;
  readonly notesSectionId: string;
  readonly savedNotePageId: string;
  readonly waitingNotePageId: string;
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
    !["notesPageId", "notesSectionId", "savedNotePageId", "waitingNotePageId"].every(
      (key) => typeof candidate[key] === "string",
    ) ||
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

const captureOpenTodo = async (port: ScenarioSeedPort, body: string, scope?: InboxScope) => {
  const message = await port.sendInboxMessage(body, scope);
  // Advice settles suggestion work; only confirming it would handle the message.
  await port.proposeInboxDispatch({
    pageIds: [message.pageId],
    action: { type: "keep" },
    kind: "todo",
    summary: "Add this to Todo.",
    rationale: null,
  });
  return message;
};

const setInboxPageStatus = async (
  port: ScenarioSeedPort,
  projectId: string,
  pageId: string,
  dataSourceId: DataSourceId,
  status: "doing" | "review",
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
  const website = await port.createProject({ name: "Website", sources: [workspace] });
  const workingThreadId = createUuidV7();
  const working = await port.createRelatedChat({
    projectId: project.id,
    relatedPageIds: [],
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
    "Compare changelog layouts when we revisit the release notes.",
  );
  await port.proposeInboxDispatch({
    pageIds: [kept.pageId],
    action: { type: "keep" },
    kind: "todo",
    summary: "Add the comparison to Todo.",
    rationale: "Work to hold for a later decision.",
  });
  await port.keepInboxEntries([kept.pageId]);

  const dispatched = await port.sendInboxMessage(
    "Research how three other assistants onboard new users.\nI want a one-page comparison, not code.",
  );
  await port.dispatchInboxEntries({
    pageIds: [dispatched.pageId],
    action: {
      type: "send_to_chat",
      additions: [],
      sessionId: working.sessionId,
      prompt: "Compare three assistant onboarding flows in one page. Do not change code.",
    },
  });
  // A confirmed dispatch is handled, so Activity already holds it.
  const delivered = (await port.readHandledMessages()).find(
    (item) => item.pageId === dispatched.pageId,
  )?.proposal;
  if (!delivered) throw new Error("inbox/triage dispatched message has no proposal");
  await port.completeInboxDispatch(delivered.proposalId, workingThreadId);

  await seedInboxTriageSkills(workspace);
  const newChat = await port.sendInboxMessage(
    "Homepage feels like a dev tool. Maybe it should read like a personal assistant? Use $positioning-context.",
  );
  await port.proposeInboxDispatch({
    pageIds: [newChat.pageId],
    action: {
      type: "new_chat",
      additions: [],
      projectId: project.id,
      prompt:
        "Compare positioning the homepage as a developer tool versus a personal assistant. Use $positioning-context to read the current homepage and notes, then deliver a short comparison and the decisions I need to make. Do not change code.",
      agent: {
        instanceId: agentRuntimeProviderId({ kind: "codex" })!,
        model: null,
        reasoningEffort: null,
        serviceTier: null,
      },
      skills: inboxTriageSkills,
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
      additions: [],
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
      additions: [],
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
      // Interaction and visual work lead on Opus; the suggestion offers the arithmetic to Sol.
      additions: [
        "You may hand the breakpoint width arithmetic and its unit tests to GPT-6.1 Sol.",
        "The Board's column layout lives in `src/renderer/components/board/`.",
      ],
      agent: {
        instanceId: DEFAULT_CLAUDE_INSTANCE_ID,
        model: "claude-opus-5-5",
        reasoningEffort: "high",
        serviceTier: null,
      },
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
      additions: [],
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

  const starterNote = await port.sendInboxMessage(
    "A reference for the design library.",
    nodexInbox,
  );
  await port.dispatchInboxEntries({
    pageIds: [starterNote.pageId],
    action: { type: "save_to_notes", parentPageId: null },
  });
  const notesPageId = await port.readInboxNotesPage(nodexInbox);
  if (!notesPageId) throw new Error("inbox/triage Notes page was not created");
  const notesSectionId = createUuidV7();
  await port.createStandalonePage({
    projectId: project.id,
    pageId: notesSectionId,
    parentPageId: notesPageId,
    operationId: createUuidV7(),
    documentId: createUuidV7(),
    title: "Design references",
  });
  const savedNote = await port.sendInboxMessage(
    "Keep the typography comparison for reference.",
    nodexInbox,
  );
  await port.dispatchInboxEntries({
    pageIds: [savedNote.pageId],
    action: { type: "save_to_notes", parentPageId: notesSectionId },
  });
  const waitingNote = await port.sendInboxMessage(
    "Reference for the new sidebar spacing.",
    nodexInbox,
  );
  await port.proposeInboxDispatch({
    pageIds: [waitingNote.pageId],
    action: { type: "save_to_notes", parentPageId: notesSectionId },
    kind: "note",
    summary: "Save to Design references.",
    rationale: "Reference for future design work.",
  });

  const movedNote = "Keep the drag handle visible while moving a block.";
  const libraryInboxMovedWithChat = await captureOpenTodo(port, movedNote);
  const inboxMovedWithChat = await captureOpenTodo(port, movedNote, nodexInbox);
  const inboxMovedNoChat = await captureOpenTodo(
    port,
    "Review the empty search results copy.",
    nodexInbox,
  );
  const inboxPlainTriage = await captureOpenTodo(
    port,
    "Try a quieter notification sound.",
    nodexInbox,
  );
  const inboxTriageTwoChats = await captureOpenTodo(
    port,
    "Check keyboard focus after closing search.",
    nodexInbox,
  );
  const inboxTriageOneIdleChat = await captureOpenTodo(
    port,
    "The export preview needs a final look.",
    nodexInbox,
  );

  await setInboxPageStatus(
    port,
    project.id,
    libraryInboxMovedWithChat.pageId,
    librarySource.dataSourceId,
    "doing",
  );
  await setInboxPageStatus(
    port,
    project.id,
    inboxMovedWithChat.pageId,
    projectSource.dataSourceId,
    "doing",
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
    relatedPageIds: [inboxMovedWithChat.pageId, libraryInboxMovedWithChat.pageId],
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
    relatedPageIds: [inboxTriageTwoChats.pageId],
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
    relatedPageIds: [inboxTriageTwoChats.pageId],
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
    relatedPageIds: [inboxTriageOneIdleChat.pageId],
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

  const laterTimed = await port.sendInboxMessage("Review the launch checklist next week.");
  const laterReturned = await port.sendInboxMessage(
    "Check the new template with an empty Project.",
  );
  const remindAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
  // A message that says it can wait: Nodex proposes Later and the person decides.
  const laterSuggested = await port.sendInboxMessage(
    "Revisit the pricing page copy in three days.",
  );
  await port.proposeInboxDispatch({
    pageIds: [laterSuggested.pageId],
    action: { type: "later", remindAt: new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString() },
    kind: "todo",
    summary: "Set this aside for three days.",
    rationale: "The message asks to wait three days.",
  });
  const returnAt = Date.now() + 2_000;
  await port.setInboxLater([laterReturned.pageId], new Date(returnAt).toISOString());
  await port.setInboxLater([laterTimed.pageId], remindAt);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, returnAt - Date.now() + 1)));

  return {
    version: 1,
    scenarioId: INBOX_TRIAGE_SCENARIO_ID,
    scenarioRevision: INBOX_TRIAGE_SCENARIO_REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey: {
      [PAGE_KEYS.notesPage]: notesPageId,
      [PAGE_KEYS.notesSection]: notesSectionId,
      [PAGE_KEYS.savedNote]: savedNote.pageId,
      [PAGE_KEYS.waitingNote]: waitingNote.pageId,
      [PAGE_KEYS.laterTimed]: laterTimed.pageId,
      [PAGE_KEYS.laterReturned]: laterReturned.pageId,
      [PAGE_KEYS.laterSuggested]: laterSuggested.pageId,
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
  const inbox = (await port.readInbox()).items;
  const later = (await port.readInbox(undefined, "later")).items;
  const returned = inbox.find(
    (item) => item.pageId === manifest.pageIdsByKey[PAGE_KEYS.laterReturned],
  );
  if (
    !later.find((item) => item.pageId === manifest.pageIdsByKey[PAGE_KEYS.laterTimed])?.later
      ?.until ||
    !returned?.later ||
    Date.parse(returned.later.until) > Date.now()
  )
    throw new Error("inbox/triage Later fixtures are missing");

  const projectScope = projectInbox(manifest.projectId);
  const projectItems = (await port.readInbox(projectScope)).items;
  const handled = await port.readHandledMessages({ kind: "all" });
  const items = [
    ...new Map([...handled, ...inbox].map((item) => [item.rowKind + item.pageId, item])).values(),
  ];
  const notesPageId = manifest.pageIdsByKey[PAGE_KEYS.notesPage];
  const notesSectionId = manifest.pageIdsByKey[PAGE_KEYS.notesSection];
  const savedNotePageId = manifest.pageIdsByKey[PAGE_KEYS.savedNote];
  const waitingNotePageId = manifest.pageIdsByKey[PAGE_KEYS.waitingNote];
  const savedNote = handled.find((item) => item.pageId === savedNotePageId);
  const waitingNote = projectItems.find((item) => item.pageId === waitingNotePageId);
  if (
    !notesPageId ||
    !notesSectionId ||
    !savedNotePageId ||
    !waitingNotePageId ||
    notesPageId !== (await port.readInboxNotesPage(projectScope)) ||
    !savedNote ||
    savedNote.waiting ||
    savedNote.pageStatus ||
    savedNote.pageKey ||
    waitingNote?.kind !== "note" ||
    waitingNote.proposal?.action.type !== "save_to_notes"
  )
    throw new Error("inbox/triage Notes fixtures are missing");
  const inspectMessage = async (
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
    const item = (status === "triage" ? (library ? inbox : projectItems) : handled).find(
      (entry) => entry.rowKind === "intake" && entry.pageId === pageId,
    );
    const [chats, activity] = await Promise.all([
      port.readPageChats(pageId),
      port.readPageChatActivity([pageId]),
    ]);
    const summary = activity.summaries.find((entry) => entry.pageId === pageId);
    if (
      !item ||
      item.waiting !== (status === "triage") ||
      (status === "triage" &&
        (item.proposal?.state !== "open" || item.proposal.action.type !== "keep")) ||
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
      throw new Error(`inbox/triage ${key} did not retain its Status and linked Chats`);
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
    inspectMessage(PAGE_KEYS.inboxMovedWithChat, "doing", [CHAT_KEYS.moved], {
      workingCount: 1,
    }),
    inspectMessage(PAGE_KEYS.inboxMovedNoChat, "review", []),
    inspectMessage(PAGE_KEYS.inboxTriageTwoChats, "triage", [CHAT_KEYS.idle, CHAT_KEYS.waiting], {
      waitingOnUserInputCount: 1,
    }),
    inspectMessage(PAGE_KEYS.inboxTriageOneIdleChat, "triage", [CHAT_KEYS.single]),
    inspectMessage(PAGE_KEYS.inboxPlainTriage, "triage", []),
    inspectMessage(
      PAGE_KEYS.libraryInboxMovedWithChat,
      "doing",
      [CHAT_KEYS.moved],
      { workingCount: 1 },
      true,
    ),
  ]);
  const facts: InboxTriageScenarioFacts = {
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    entryCount: items.filter((item) => item.rowKind === "intake").length,
    inboxCount: inbox.length,
    needsDecisionCount: items.filter((item) => item.waiting && item.proposal?.state === "open")
      .length,
    keptCount: items.filter(
      (item) =>
        item.pageStatus?.id === "plan" && item.pageId === manifest.pageIdsByKey[PAGE_KEYS.kept],
    ).length,
    dispatchedCount: items.filter(
      (item) =>
        item.proposal?.state === "completed" && item.proposal.action.type === "send_to_chat",
    ).length,
    failedSuggestionCount: items.filter((item) => item.suggestionState === "failed").length,
    projectInboxCount: projectItems.length,
    notesPageId,
    notesSectionId,
    savedNotePageId,
    waitingNotePageId,
    inboxMovedWithChat,
    inboxMovedNoChat,
    inboxTriageTwoChats,
    inboxTriageOneIdleChat,
    inboxPlainTriage,
    libraryInboxMovedWithChat,
  };
  if (
    facts.entryCount !== 21 ||
    facts.inboxCount !== 15 ||
    facts.needsDecisionCount !== 12 ||
    facts.keptCount !== 1 ||
    facts.dispatchedCount !== 1 ||
    facts.failedSuggestionCount !== 1 ||
    facts.projectInboxCount !== 8 ||
    projectItems
      .filter((item) => item.rowKind === "intake")
      .slice(0, 3)
      .map((item) => item.pageId)
      .join(",") !==
      [inboxTriageOneIdleChat.pageId, inboxTriageTwoChats.pageId, inboxPlainTriage.pageId].join(",")
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
