import { describe, expect, it } from "vitest";
import type { InboxItem, InboxProposal } from "../../../shared/inbox";
import {
  describeInboxAction,
  describeInboxChatStatus,
  describeInboxOutcome,
  groupInboxItemsByDay,
  inboxAwaitingIndicatorPageId,
  inboxPageRoutingContext,
  inboxTimestampSeparators,
  inboxTriageModel,
  isInboxItemHandled,
} from "./inbox-presentation";

const item = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  pageId: "page:1",
  outcome: null,
  basis: { pageId: "page:1", generation: 1, headSeq: 1, placementRevision: 1 },
  pageKey: "IN-1",
  title: "Message",
  body: "Message",
  bodyTruncated: false,
  bodyEditable: true,
  submittedAt: "2026-10-11T10:00:00.000Z",
  source: { kind: "user" },
  kind: null,
  state: "open",
  suggestionState: "settled",
  suggestionError: null,
  scope: { kind: "library" },
  location: { kind: "inbox" },
  proposal: null,
  revision: 1,
  ...overrides,
});

const proposal = (overrides: Partial<InboxProposal> = {}): InboxProposal => ({
  proposalId: "proposal:1",
  revision: 1,
  origin: "agent",
  state: "open",
  pageIds: ["page:1"],
  basis: [{ pageId: "page:1", generation: 1, headSeq: 1, placementRevision: 1 }],
  action: { type: "new_chat", projectId: "project:nodex", prompt: "Research" },
  kind: "question",
  summary: "Compare both positions",
  rationale: null,
  producedBy: "Codex",
  targetProjectName: "Nodex",
  chat: null,
  failureMessage: null,
  failureKind: null,
  createdAt: "2026-10-11T10:00:01.000Z",
  updatedAt: "2026-10-11T10:00:01.000Z",
  ...overrides,
});

const chat = {
  sessionId: "session:1",
  projectId: "project:nodex",
  projectName: "Nodex",
  displayTitle: "Homepage positioning",
  threadId: "thread:1",
  status: { statusType: "idle" as const, activeFlags: [] },
  unread: true,
  archived: false,
};

describe("inboxTimestampSeparators", () => {
  const at = (iso: string) => item({ pageId: iso, submittedAt: iso });
  const ms = (iso: string) => Date.parse(iso);

  it("marks a fresh stream with nothing and an hour-long pause with its time", () => {
    const items = [
      at("2026-10-11T10:00:00.000Z"),
      at("2026-10-11T10:59:00.000Z"),
      at("2026-10-11T12:00:00.000Z"),
      at("2026-10-11T13:00:00.000Z"),
    ];
    expect(inboxTimestampSeparators(items, ms("2026-10-11T10:30:00.000Z"))).toEqual([
      null,
      null,
      ms("2026-10-11T12:00:00.000Z"),
      null,
    ]);
  });

  it("dates the first message once it is over an hour old", () => {
    const first = at("2026-10-11T10:00:00.000Z");
    expect(inboxTimestampSeparators([first], ms("2026-10-11T11:00:00.000Z"))).toEqual([null]);
    expect(inboxTimestampSeparators([first], ms("2026-10-11T11:00:00.001Z"))).toEqual([
      ms("2026-10-11T10:00:00.000Z"),
    ]);
  });
});

describe("inboxAwaitingIndicatorPageId", () => {
  it("marks only the newest message still waiting for advice", () => {
    const waiting = (pageId: string) => item({ pageId, suggestionState: "pending" });
    const advised = item({ pageId: "page:advised", proposal: proposal() });
    expect(
      inboxAwaitingIndicatorPageId([waiting("page:a"), waiting("page:b"), advised], true),
    ).toBe("page:b");
    expect(inboxAwaitingIndicatorPageId([advised], true)).toBeNull();
    // Nothing is working on a message while suggestions are off.
    expect(inboxAwaitingIndicatorPageId([waiting("page:a")], false)).toBeNull();
  });
});

describe("inboxPageRoutingContext", () => {
  it("reads a message from where its Page lives now", () => {
    const filed = (projectId: string | null) =>
      item({
        location: {
          kind: "database",
          databaseId: "db",
          databaseName: "Tasks",
          projectId,
          projectName: projectId,
        },
      });
    expect(inboxPageRoutingContext(filed("project:site"))).toEqual({
      kind: "project",
      projectId: "project:site",
    });
    expect(inboxPageRoutingContext(filed(null))).toEqual({ kind: "library" });
    expect(
      inboxPageRoutingContext(item({ scope: { kind: "project", projectId: "project:nodex" } })),
    ).toEqual({ kind: "project", projectId: "project:nodex" });
  });
});

describe("inboxTriageModel", () => {
  it("shows suggesting only while suggestions are enabled", () => {
    const pending = item({ suggestionState: "pending" });
    expect(inboxTriageModel(pending, true).kind).toBe("suggesting");
    expect(inboxTriageModel(pending, false).kind).toBe("undecided");
  });

  it("asks for a decision on an open suggestion and reports failures in place", () => {
    expect(inboxTriageModel(item({ proposal: proposal() }), true).kind).toBe("suggestion");
    expect(
      inboxTriageModel(item({ suggestionState: "failed", suggestionError: "Offline" }), true),
    ).toEqual({ kind: "suggestion-failed", message: "Offline" });
    expect(
      inboxTriageModel(
        item({ proposal: proposal({ state: "failed", failureMessage: "Sign in first" }) }),
        true,
      ),
    ).toMatchObject({ kind: "dispatch-failed", message: "Sign in first" });
  });
});

describe("isInboxItemHandled", () => {
  it("keeps an uncertain delivery visible for checking and a reviewed new send", () => {
    const uncertain = item({
      proposal: proposal({
        state: "dispatching",
        failureKind: "unknown",
        failureMessage: "Check the destination chat",
      }),
    });
    expect(isInboxItemHandled(uncertain)).toBe(false);
    expect(inboxTriageModel(uncertain, true)).toMatchObject({
      kind: "dispatch-failed",
      message: "Check the destination chat",
    });
  });

  it("matches Core: confirmed chats and filed, kept, or done messages leave the Inbox", () => {
    const elsewhere = {
      kind: "database",
      databaseId: "db",
      databaseName: "Nodex DB",
      projectId: "project:nodex",
      projectName: "Nodex",
    } as const;
    expect(isInboxItemHandled(item({ proposal: proposal() }))).toBe(false);
    expect(isInboxItemHandled(item({ proposal: proposal({ state: "dispatching" }) }))).toBe(true);
    expect(isInboxItemHandled(item({ proposal: proposal({ state: "failed" }) }))).toBe(false);
    expect(isInboxItemHandled(item({ state: "kept", outcome: "kept" }))).toBe(true);
    expect(isInboxItemHandled(item({ state: "done", outcome: "done" }))).toBe(true);
    // Filing marks the message kept; moving its Page by other means does not handle it.
    expect(isInboxItemHandled(item({ state: "kept", outcome: "kept", location: elsewhere }))).toBe(
      true,
    );
    expect(isInboxItemHandled(item({ location: elsewhere }))).toBe(false);
  });
});

describe("describeInboxOutcome", () => {
  it("keeps triage outcomes independent of the Page location", () => {
    for (const state of ["kept", "done"] as const) {
      expect(
        describeInboxOutcome(item({ state, outcome: state, location: { kind: "other" } })),
      ).toMatchObject({
        icon: state === "kept" ? "keep" : "done",
        canReturn: true,
      });
    }
    expect(describeInboxOutcome(item({ location: { kind: "other" } }))).toMatchObject({
      icon: "inbox",
      canReturn: false,
    });
  });
  it("keeps a newly dispatched Session navigable before its Thread exists", () => {
    expect(
      describeInboxOutcome(
        item({
          proposal: proposal({
            state: "dispatching",
            chat: { ...chat, threadId: null },
          }),
        }),
      ).open,
    ).toEqual({ kind: "session", sessionId: "session:1" });
  });

  it("names where a handled message went and how to get back to it", () => {
    expect(
      describeInboxOutcome(
        item({ outcome: "chat", proposal: proposal({ state: "completed", chat }) }),
      ),
    ).toEqual({
      icon: "chat",
      label: "Started “Homepage positioning”",
      status: { label: "New reply", tone: "attention" },
      open: { kind: "session", sessionId: "session:1" },
      canReturn: false,
    });
    expect(
      describeInboxOutcome(
        item({
          proposal: proposal({
            state: "dispatching",
            action: { type: "send_to_chat", sessionId: "session:1", prompt: "x" },
            chat,
          }),
        }),
      ),
    ).toMatchObject({ icon: "pending", label: "Sending to “Homepage positioning”" });
    expect(
      describeInboxOutcome(
        item({
          state: "kept",
          outcome: "moved",
          proposal: proposal({
            state: "completed",
            action: { type: "move_to_project", projectId: "project:nodex" },
          }),
          location: {
            kind: "database",
            databaseId: "db",
            databaseName: "Nodex DB",
            projectId: "project:nodex",
            projectName: "Nodex",
          },
        }),
      ),
    ).toMatchObject({ icon: "move", label: "Moved to Nodex", open: { kind: "database" } });
    expect(
      describeInboxOutcome(item({ state: "kept", outcome: "kept", kind: "question" })),
    ).toMatchObject({
      label: "Kept as question",
      canReturn: true,
    });
    expect(describeInboxOutcome(item({ state: "done", outcome: "done" }))).toMatchObject({
      label: "Done",
      canReturn: true,
    });
  });
});

describe("describeInboxAction", () => {
  it("names the exact destination and switches send to queue for a busy chat", () => {
    expect(
      describeInboxAction(
        { type: "new_chat", projectId: "project:nodex", prompt: "x" },
        {
          targetProjectName: "Nodex",
          chat: null,
        },
      ),
    ).toEqual({ verb: "Start chat", target: "New chat in Nodex" });
    const busy = {
      sessionId: "session:1",
      projectId: null,
      projectName: null,
      displayTitle: "Sidebar polish",
      threadId: "thread:1",
      status: { statusType: "active" as const, activeFlags: [] },
      unread: false,
      archived: false,
    };
    expect(
      describeInboxAction(
        { type: "send_to_chat", sessionId: "session:1", prompt: "x" },
        { targetProjectName: null, chat: busy },
      ),
    ).toEqual({ verb: "Queue", target: "Send to “Sidebar polish” after it finishes" });
    expect(describeInboxChatStatus(busy)).toEqual({ label: "Working", tone: "working" });
    expect(
      describeInboxChatStatus({
        ...busy,
        status: { statusType: "active", activeFlags: ["waitingOnApproval"] },
      }),
    ).toEqual({ label: "Waiting", tone: "working" });
    expect(
      describeInboxChatStatus({
        ...busy,
        status: {
          statusType: "active",
          activeFlags: ["waitingOnApproval", "waitingOnUserInput"],
        },
      }),
    ).toEqual({ label: "Needs input", tone: "attention" });
  });
});

describe("groupInboxItemsByDay", () => {
  it("keeps the given order and labels recent days", () => {
    const now = new Date(2026, 9, 11, 18);
    const sections = groupInboxItemsByDay(
      [
        item({ pageId: "a", submittedAt: new Date(2026, 9, 10, 9).toISOString() }),
        item({ pageId: "b", submittedAt: new Date(2026, 9, 11, 9).toISOString() }),
        item({ pageId: "c", submittedAt: new Date(2026, 9, 11, 10).toISOString() }),
      ],
      now,
    );
    expect(sections.map((section) => section.label)).toEqual(["Yesterday", "Today"]);
    expect(sections[1]?.items.map((entry) => entry.pageId)).toEqual(["b", "c"]);
  });
});
