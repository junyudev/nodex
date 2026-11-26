import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectInbox } from "../../../src/shared/inbox";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const INBOX_PAGE_SUGGESTIONS_SCENARIO_ID = "inbox/page-suggestions" as const;
const REVISION = 2 as const;
const AGENT = { instanceId: "codex", model: "gpt-6.1-sol", effort: "high" } as const;

const SKILLS = [
  { name: "ux-writing", reason: "Write empty states in Nodex's product voice." },
] as const;

/**
 * Inbox messages as their Pages show them: suggestions waiting for a decision beside one that
 * failed and one never asked for, then messages already sent to chats, by the reader from
 * Nodex's suggestion, by Nodex under the reader's standing consent, and by hand.
 */
const materialize = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  await Promise.all(
    SKILLS.map(async ({ name, reason }) => {
      const directory = join(workspace, ".agents", "skills", name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${reason}\n---\n\nFollow the product voice guide.\n`,
      );
    }),
  );
  const project = await port.createProject({ name: "Nodex", sources: [workspace] });
  const inbox = projectInbox(project.id);
  const workingThreadId = createUuidV7();
  const working = await port.createRelatedChat({
    projectId: project.id,
    relatedPageIds: [],
    noThreadFallbackTitle: "Board polish",
    thread: {
      threadId: workingThreadId,
      threadName: "Board polish",
      threadPreview: "Tightening Board column headers and card spacing",
      statusType: "idle",
      statusActiveFlags: [],
      unread: false,
    },
  });
  const agent = {
    instanceId: AGENT.instanceId,
    model: AGENT.model,
    reasoningEffort: AGENT.effort,
    serviceTier: null,
  };

  const suggested = await port.sendInboxMessage(
    [
      "Empty Board columns feel dead. They should say what belongs in them,",
      "and Done should not invite new cards.",
    ].join("\n"),
    inbox,
  );
  await port.settleRoutingSuggestion({
    pageIds: [suggested.pageId],
    action: {
      type: "new_chat",
      projectId: project.id,
      // The Inbox's own model, so the decision reads as the reader's Inbox would start it.
      agent: null,
      prompt:
        "Give each empty Board column a one-line hint about what belongs in it, and keep Done from inviting new cards. Show me the copy before changing anything else.",
      additions: [
        "The empty column renders in `src/renderer/components/workbench/database-board/`; start there.",
        "Once the layout is settled, a faster model can review the copy.",
      ],
      skills: [...SKILLS],
    },
    kind: "todo",
    summary: "Write empty-column hints for the Board.",
    rationale:
      "A concrete UI change in Nodex. The Board's empty state lives in database-board, so a new chat there can start from the right files.",
  });

  const failed = await port.sendInboxMessage(
    "Should the Board remember its scroll position per View?",
    inbox,
  );
  await port.recordInboxSuggestionFailure([failed.pageId], "The suggestion model is unavailable");

  const unadvised = await port.sendInboxMessage(
    "Card previews could show the first image in the Page.",
    inbox,
  );

  const confirmed = await port.sendInboxMessage(
    "Column headers jump when a card is dragged across them.",
    inbox,
  );
  const confirmedSuggestion = await port.settleRoutingSuggestion({
    pageIds: [confirmed.pageId],
    action: {
      type: "send_to_chat",
      sessionId: working.sessionId,
      prompt: "Also stop the column headers from jumping while a card is dragged across them.",
      additions: [
        "The header height changes when the drop indicator mounts; check `board-card-drop-strategy.ts`.",
        "Record the drag in a short video before and after.",
      ],
    },
    kind: "todo",
    summary: "Add the header jump to the Board polish chat.",
    rationale: "It is the same surface the Board polish chat is already changing.",
  });
  // The reader kept the lead and dropped the video before confirming.
  await port.confirmInboxSuggestion({
    proposalId: confirmedSuggestion,
    selection: AGENT,
    confirmedBy: "user",
    action: {
      type: "send_to_chat",
      sessionId: working.sessionId,
      prompt: "Also stop the column headers from jumping while a card is dragged across them.",
      additions: [
        "The header height changes when the drop indicator mounts; check `board-card-drop-strategy.ts`.",
      ],
    },
  });
  await port.completeInboxDispatch(confirmedSuggestion, workingThreadId);

  await port.setInboxRoutingConsent(true);
  const started = await port.sendInboxMessage(
    "Audit the README links and fix the broken ones.",
    inbox,
  );
  const startedSuggestion = await port.settleRoutingSuggestion({
    pageIds: [started.pageId],
    action: {
      type: "new_chat",
      projectId: project.id,
      agent,
      prompt: "Audit the README links and fix the broken ones.",
      additions: [],
    },
    kind: "todo",
    summary: "Check and repair the README links.",
    rationale: "A clear, self-contained request in Nodex that you asked for directly.",
    explicitRequest: true,
    automaticDispatch: true,
  });
  await port.confirmInboxSuggestion({
    proposalId: startedSuggestion,
    selection: AGENT,
    confirmedBy: "nodex",
  });
  await port.completeInboxDispatch(startedSuggestion, createUuidV7());
  await port.setInboxRoutingConsent(false);

  const byHand = await port.sendInboxMessage("Board cards need a compact density.", inbox);
  await port.dispatchInboxEntries({
    pageIds: [byHand.pageId],
    scope: inbox,
    action: {
      type: "send_to_chat",
      sessionId: working.sessionId,
      prompt: "Add a compact card density to the Board, behind the View's layout menu.",
      additions: [],
    },
  });
  const delivered = (await port.readHandledMessages()).find(
    (item) => item.pageId === byHand.pageId,
  )?.proposal;
  if (!delivered) throw new Error("inbox/page-suggestions hand dispatch has no proposal");
  await port.completeInboxDispatch(delivered.proposalId, workingThreadId);

  if (!project.defaultDatabaseViewId) throw new Error("inbox/page-suggestions has no default View");
  return {
    version: 1,
    scenarioId: INBOX_PAGE_SUGGESTIONS_SCENARIO_ID,
    scenarioRevision: REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey: {
      suggested: suggested.pageId,
      failed: failed.pageId,
      unadvised: unadvised.pageId,
      confirmed: confirmed.pageId,
      started: started.pageId,
      byHand: byHand.pageId,
    },
    entityIdsByKey: { workingSession: working.sessionId },
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
};

export const inboxPageSuggestionsScenario: ScenarioDomainRecipe = {
  id: INBOX_PAGE_SUGGESTIONS_SCENARIO_ID,
  revision: REVISION,
  materialize,
  async inspect(port, manifest) {
    const page = (key: string) => manifest.pageIdsByKey[key];
    const [waiting, handled] = await Promise.all([
      port.readInbox(projectInbox(manifest.projectId)),
      port.readHandledMessages(projectInbox(manifest.projectId)),
    ]);
    const waitingItem = (key: string) => waiting.items.find((item) => item.pageId === page(key));
    const handledProposal = (key: string) =>
      handled.find((item) => item.pageId === page(key))?.proposal;
    if (
      waitingItem("suggested")?.proposal?.state !== "open" ||
      waitingItem("failed")?.suggestionState !== "failed" ||
      !waitingItem("unadvised") ||
      waitingItem("unadvised")?.proposal ||
      handledProposal("confirmed")?.confirmedBy !== "user" ||
      handledProposal("started")?.confirmedBy !== "nodex" ||
      handledProposal("byHand")?.origin !== "user"
    )
      throw new Error(`inbox/page-suggestions does not match revision ${REVISION}`);
    return { scenarioId: INBOX_PAGE_SUGGESTIONS_SCENARIO_ID, scenarioRevision: REVISION };
  },
  parseFacts: parseScenarioFacts,
};
