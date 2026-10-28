import { describe, expect, test } from "vite-plus/test";

import { projectInbox } from "../../shared/inbox";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  INBOX_TRIAGE_SCENARIO_ID,
  requireInboxTriageScenarioFacts,
} from "../../../scripts/scenarios/scenarios/inbox-triage";

describe("inbox/triage scenario", () => {
  test("materializes every Inbox and History state without pending Agent work", async () => {
    await withCoreScenario({ scenarioId: INBOX_TRIAGE_SCENARIO_ID }, async (context) => {
      const facts = requireInboxTriageScenarioFacts(context.facts);
      expect(facts).toMatchObject({
        entryCount: 8,
        inboxCount: 6,
        needsDecisionCount: 5,
        keptCount: 1,
        dispatchedCount: 1,
        failedSuggestionCount: 1,
        projectInboxCount: 8,
      });
      expect(() =>
        requireInboxTriageScenarioFacts({ ...facts, inboxMovedWithChat: undefined }),
      ).toThrow("inbox/triage facts are invalid");
      expect(() =>
        requireInboxTriageScenarioFacts({
          ...facts,
          inboxTriageTwoChats: { pageId: facts.inboxTriageTwoChats.pageId, sessionIds: [null] },
        }),
      ).toThrow("inbox/triage facts are invalid");
      const [library, project] = await Promise.all([
        context.seed.readInbox("inbox"),
        context.seed.readInbox("inbox", projectInbox(context.manifest.projectId)),
      ]);
      const pending = [...library.items, ...project.items];
      expect(pending.some((item) => item.suggestionState === "pending")).toBe(false);
      expect(
        pending.some(
          (item) => item.proposal?.state === "dispatching" || item.proposal?.state === "failed",
        ),
      ).toBe(false);
    });
  });

  test("keeps moved Pages and linked Chats open beside a plain Project Inbox note", async () => {
    await withCoreScenario({ scenarioId: INBOX_TRIAGE_SCENARIO_ID }, async (context) => {
      const facts = requireInboxTriageScenarioFacts(context.facts);
      const scope = projectInbox(context.manifest.projectId);
      const items = (await context.seed.readInbox("inbox", scope)).items;
      expect(items.map((item) => item.scope)).toEqual(Array.from({ length: 8 }, () => scope));
      // Newest first, like every Inbox window.
      expect(items.slice(0, 5).map((item) => item.pageId)).toEqual([
        facts.inboxTriageOneIdleChat.pageId,
        facts.inboxTriageTwoChats.pageId,
        facts.inboxPlainTriage.pageId,
        facts.inboxMovedNoChat.pageId,
        facts.inboxMovedWithChat.pageId,
      ]);
      expect(items.slice(0, 5).map((item) => item.pageStatus?.id)).toEqual([
        "triage",
        "triage",
        "triage",
        "review",
        "build",
      ]);
      expect(items.map((item) => item.proposal?.action.type)).toEqual([
        "keep",
        "keep",
        "keep",
        "keep",
        "keep",
        "move_to_project",
        "send_to_chat",
        "new_chat",
      ]);
      expect(
        items.every(
          (item) =>
            item.state === "open" && item.outcome === null && item.proposal?.state === "open",
        ),
      ).toBe(true);
      expect(facts.inboxMovedNoChat.sessionIds).toEqual([]);
      expect(facts.inboxPlainTriage.sessionIds).toEqual([]);

      const [working, twoChats, single, library] = await Promise.all([
        context.seed.readPageChats(facts.inboxMovedWithChat.pageId),
        context.seed.readPageChats(facts.inboxTriageTwoChats.pageId),
        context.seed.readPageChats(facts.inboxTriageOneIdleChat.pageId),
        context.seed.readPageChats(facts.libraryInboxMovedWithChat.pageId),
      ]);
      expect(working.items).toMatchObject([
        {
          sessionId: facts.inboxMovedWithChat.sessionIds[0],
          threadStatus: { statusType: "active", activeFlags: [] },
          unread: false,
        },
      ]);
      expect(twoChats.items).toHaveLength(2);
      expect(twoChats.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: facts.inboxTriageTwoChats.sessionIds[0],
            threadStatus: { statusType: "idle", activeFlags: [] },
            unread: false,
          }),
          expect.objectContaining({
            sessionId: facts.inboxTriageTwoChats.sessionIds[1],
            threadStatus: { statusType: "active", activeFlags: ["waitingOnUserInput"] },
            unread: false,
          }),
        ]),
      );
      expect(single.items).toMatchObject([
        {
          sessionId: facts.inboxTriageOneIdleChat.sessionIds[0],
          threadStatus: { statusType: "idle", activeFlags: [] },
          unread: false,
        },
      ]);
      expect(library.items.map((chat) => chat.sessionId)).toEqual(
        facts.inboxMovedWithChat.sessionIds,
      );
      expect(facts.libraryInboxMovedWithChat.sessionIds).toEqual(
        facts.inboxMovedWithChat.sessionIds,
      );
    });
  });

  test("keeps a written message's formatting and screenshot as its body", async () => {
    await withCoreScenario({ scenarioId: INBOX_TRIAGE_SCENARIO_ID }, async (context) => {
      const pageId = context.manifest.pageIdsByKey.picturedMessage;
      const fileId = context.manifest.entityIdsByKey?.screenshotFile;
      const item = (await context.seed.readInbox("inbox")).items.find(
        (entry) => entry.pageId === pageId,
      );
      expect(item).toMatchObject({
        body: [
          "Settings buttons have **no accessible labels**:",
          "",
          "- the gear in the toolbar",
          "- the close button on dialogs",
          "",
          `![Settings toolbar](nodex://files/${fileId})`,
        ].join("\n"),
        bodyTruncated: false,
        bodyEditable: true,
        // The label is the opening words as read, without their Markdown.
        title: "Settings buttons have no accessible labels:",
      });
    });
  });
});
