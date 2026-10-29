import { describe, expect, it } from "vitest";
import type { InboxItem, InboxProposal } from "../../../shared/inbox";
import type { InboxSuggestionPolicy } from "../../../shared/inbox-suggestion-policy";
import {
  describeInboxAction,
  describeInboxChatStatus,
  describeInboxDecision,
  describeInboxFiring,
  describeInboxOutcome,
  formatInboxTime,
  formatInboxWhen,
  groupInboxItemsByDay,
  inboxAwaitingIndicatorPageId,
  inboxBuriedImportant,
  inboxPageStatusMark,
  describeInboxSuggestionPause,
  inboxRowOffers,
  inboxPageRoutingContext,
  inboxTimestampSeparators,
  inboxTriageModel,
  isInboxItemHandled,
} from "./inbox-presentation";

const item = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  pageId: "page:1",
  outcome: null,
  basis: { pageId: "page:1", contentHash: "content:1" },
  pageKey: "IN-1",
  pageStatus: null,
  title: "Message",
  body: "Message",
  bodyTruncated: false,
  bodyEditable: true,
  submittedAt: "2026-10-11T10:00:00.000Z",
  source: { kind: "user" },
  kind: null,
  important: false,
  state: "open",
  suggestionState: "settled",
  suggestionError: null,
  firing: null,
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
  basis: [{ pageId: "page:1", contentHash: "content:1" }],
  outdated: false,
  action: {
    type: "new_chat",
    projectId: "project:nodex",
    prompt: "Research",
    agent: null,
    delegates: [],
    plan: null,
  },
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
  executionRef: null,
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

const AUTOMATIC: InboxSuggestionPolicy = { kind: "automatic" };
const ON_REQUEST: InboxSuggestionPolicy = { kind: "on_request" };
const OFF: InboxSuggestionPolicy = { kind: "off" };
const PAUSED: InboxSuggestionPolicy = {
  kind: "paused",
  pause: {
    pace: "tight",
    agent: "Codex",
    window: "Weekly",
    leftPercent: 38,
    resetsAt: "2026-10-16T10:00:00.000Z",
  },
};

describe("inboxAwaitingIndicatorPageId", () => {
  it("marks only the newest message still waiting for advice", () => {
    const waiting = (pageId: string) => item({ pageId, suggestionState: "pending" });
    const advised = item({ pageId: "page:advised", proposal: proposal() });
    expect(
      inboxAwaitingIndicatorPageId([waiting("page:a"), waiting("page:b"), advised], AUTOMATIC),
    ).toBe("page:b");
    expect(inboxAwaitingIndicatorPageId([advised], AUTOMATIC)).toBeNull();
    // Nothing is working on a message while suggestions are off.
    expect(inboxAwaitingIndicatorPageId([waiting("page:a")], OFF)).toBeNull();
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
  it("shows a running suggestion in every mode that runs one", () => {
    const pending = item({ suggestionState: "pending" });
    expect(inboxTriageModel(pending, AUTOMATIC).kind).toBe("suggesting");
    // The user asked for this one, so it runs while automatic advice steps back.
    expect(inboxTriageModel(pending, ON_REQUEST).kind).toBe("suggesting");
    expect(inboxTriageModel(pending, PAUSED).kind).toBe("suggesting");
    expect(inboxTriageModel(pending, OFF).kind).toBe("undecided");
  });

  it("shows a message waiting for automatic advice as advised only while it will be", () => {
    const waiting = item({ suggestionState: "waiting" });
    expect(inboxTriageModel(waiting, AUTOMATIC).kind).toBe("suggesting");
    expect(inboxTriageModel(waiting, ON_REQUEST).kind).toBe("undecided");
    expect(inboxTriageModel(waiting, PAUSED).kind).toBe("undecided");
    expect(inboxTriageModel(item({ suggestionState: "none" }), AUTOMATIC).kind).toBe("undecided");
  });

  it("asks for a decision on an open suggestion and reports failures in place", () => {
    expect(inboxTriageModel(item({ proposal: proposal() }), AUTOMATIC)).toEqual({
      kind: "suggestion",
      proposal: proposal(),
      refreshing: false,
      refreshError: null,
    });
    expect(
      inboxTriageModel(item({ suggestionState: "failed", suggestionError: "Offline" }), AUTOMATIC),
    ).toEqual({ kind: "suggestion-failed", message: "Offline" });
    expect(
      inboxTriageModel(
        item({ proposal: proposal({ state: "failed", failureMessage: "Sign in first" }) }),
        AUTOMATIC,
      ),
    ).toMatchObject({ kind: "dispatch-failed", message: "Sign in first" });
  });

  it("keeps an outdated suggestion while new advice runs or after it fails", () => {
    const outdated = proposal({ outdated: true });
    expect(
      inboxTriageModel(item({ proposal: outdated, suggestionState: "pending" }), ON_REQUEST),
    ).toMatchObject({ kind: "suggestion", refreshing: true, refreshError: null });
    expect(
      inboxTriageModel(
        item({ proposal: outdated, suggestionState: "failed", suggestionError: "Rate limited" }),
        AUTOMATIC,
      ),
    ).toMatchObject({ kind: "suggestion", refreshing: false, refreshError: "Rate limited" });
    // A rewrite waits for automatic advice only while suggestions run on their own.
    expect(
      inboxTriageModel(item({ proposal: outdated, suggestionState: "waiting" }), PAUSED),
    ).toMatchObject({ kind: "suggestion", refreshing: false });
  });
});

describe("describeInboxSuggestionPause", () => {
  const now = Date.parse("2026-10-11T10:00:00.000Z");

  it("says which usage ran short, what is left and when it comes back", () => {
    expect(PAUSED.kind === "paused" && describeInboxSuggestionPause(PAUSED.pause, now)).toBe(
      "Codex Weekly: 38% left, resets in 5 days",
    );
    expect(
      describeInboxSuggestionPause(
        {
          pace: "spent",
          agent: "Claude Code",
          window: "Session",
          leftPercent: 1,
          resetsAt: "2026-10-11T13:00:00.000Z",
        },
        now,
      ),
    ).toBe("Claude Code Session: used up, resets in 3 h");
    expect(
      describeInboxSuggestionPause(
        { pace: "spent", agent: "Codex", window: "Weekly", leftPercent: 0, resetsAt: null },
        now,
      ),
    ).toBe("Codex Weekly: used up");
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
    expect(inboxTriageModel(uncertain, AUTOMATIC)).toMatchObject({
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
      status: { label: "New reply", tone: "attention", inProgress: true },
      open: { kind: "session", sessionId: "session:1" },
      canReturn: false,
      done: false,
      inProgress: true,
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
        {
          type: "new_chat",
          projectId: "project:nodex",
          prompt: "x",
          agent: null,
          delegates: [],
          plan: null,
        },
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
      executionRef: null,
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
    expect(describeInboxChatStatus(busy)).toMatchObject({ label: "Working", tone: "working" });
    expect(
      describeInboxChatStatus({
        ...busy,
        status: { statusType: "active", activeFlags: ["waitingOnApproval"] },
      }),
    ).toMatchObject({ label: "Waiting", tone: "working" });
    expect(
      describeInboxChatStatus({
        ...busy,
        status: {
          statusType: "active",
          activeFlags: ["waitingOnApproval", "waitingOnUserInput"],
        },
      }),
    ).toMatchObject({ label: "Needs input", tone: "attention" });
  });
});

describe("chat progress", () => {
  const runtime = {
    ...chat,
    status: null,
    unread: false,
    executionRef: { runtimeId: "runtime:1", threadId: "thread:1" },
  };

  it("reads a Runtime-bound chat's live activity instead of a Thread status it never has", () => {
    expect(describeInboxChatStatus(runtime, "running")).toEqual({
      label: "Working",
      tone: "working",
      inProgress: true,
    });
    expect(describeInboxChatStatus(runtime, "background")).toMatchObject({ label: "Working" });
    expect(describeInboxChatStatus(runtime, "waiting")).toEqual({
      label: "Needs input",
      tone: "attention",
      inProgress: true,
    });
    // Idle, it is finished once its reply has been read.
    expect(describeInboxChatStatus(runtime, null)).toEqual({
      label: "Idle",
      tone: "quiet",
      inProgress: false,
    });
    expect(describeInboxChatStatus({ ...runtime, unread: true }, null)).toEqual({
      label: "New reply",
      tone: "attention",
      inProgress: true,
    });
  });

  it("keeps dispatched work in progress until the user closes it, whatever its chat does", () => {
    const delivered = (state: "open" | "done", live: "running" | null) =>
      describeInboxOutcome(
        item({ state, outcome: "chat", proposal: proposal({ state: "completed", chat: runtime }) }),
        live,
      );
    expect(delivered("open", "running")).toMatchObject({ inProgress: true, done: false });
    expect(delivered("open", null)).toMatchObject({ inProgress: false, done: false });
    expect(delivered("done", "running")).toMatchObject({
      label: "Started “Homepage positioning”",
      status: { label: "Done" },
      inProgress: false,
      done: true,
      canReturn: false,
    });
    expect(
      describeInboxOutcome(item({ proposal: proposal({ state: "dispatching", chat: null }) })),
    ).toMatchObject({ icon: "pending", inProgress: true, done: false });
    expect(describeInboxOutcome(item({ state: "kept", outcome: "kept" }))).toMatchObject({
      inProgress: false,
      done: null,
    });
  });
});

describe("describeInboxDecision", () => {
  it("says where a message went before Core's handled message arrives", () => {
    expect(
      describeInboxDecision(item(), {
        kind: "chat",
        type: "new_chat",
        sessionId: "session:new",
        chatTitle: null,
        projectName: "Nodex",
      }),
    ).toMatchObject({
      icon: "pending",
      label: "Starting a chat in Nodex",
      open: { kind: "session", sessionId: "session:new" },
    });
    expect(
      describeInboxDecision(item(), {
        kind: "chat",
        type: "send_to_chat",
        sessionId: "session:1",
        chatTitle: "Homepage positioning",
        projectName: null,
      }).label,
    ).toBe("Sending to “Homepage positioning”");
    // The kind it keeps is the one the user set, else the one suggested.
    expect(
      describeInboxDecision(item({ proposal: proposal({ kind: "todo" }) }), { kind: "keep" }).label,
    ).toBe("Kept as todo");
    expect(describeInboxDecision(item(), { kind: "done" }).label).toBe("Done");
    expect(describeInboxDecision(item(), { kind: "move", projectName: "Nodex" }).label).toBe(
      "Moved to Nodex",
    );
  });
});

describe("formatInboxWhen", () => {
  it("shows a time today and the day otherwise", () => {
    const now = new Date(2026, 9, 11, 18);
    expect(formatInboxWhen(new Date(2026, 9, 11, 9, 5).toISOString(), now)).toBe(
      formatInboxTime(new Date(2026, 9, 11, 9, 5).toISOString()),
    );
    expect(formatInboxWhen(new Date(2026, 9, 10, 9).toISOString(), now)).toBe("Yesterday");
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

describe("inboxBuriedImportant", () => {
  const important = ["page:plan", "page:pricing", "page:review"].map((pageId) => ({
    pageId,
    title: pageId,
    submittedAt: "2026-10-11T10:00:00.000Z",
  }));

  it("points at the longest-waiting important message out of view", () => {
    const inView = (pageId: string) => pageId === "page:plan";
    expect(inboxBuriedImportant(important, 5, inView)).toEqual({
      message: important[1],
      position: 2,
      total: 5,
    });
  });

  it("points nowhere while every important message is in view", () => {
    expect(inboxBuriedImportant(important, 3, () => true)).toBeNull();
    expect(inboxBuriedImportant([], 0, () => false)).toBeNull();
  });
});

describe("inboxPageStatusMark", () => {
  it("marks a message only once its Page has left Triage", () => {
    expect(inboxPageStatusMark(item({ pageStatus: { id: "triage", label: "Triage" } }))).toBeNull();
    expect(inboxPageStatusMark(item({ pageStatus: null }))).toBeNull();
    expect(inboxPageStatusMark(item({ pageStatus: { id: "build", label: "Build" } }))).toEqual({
      id: "build",
      label: "Build",
    });
  });

  it("follows the status option, not its name, so a renamed Triage stays quiet", () => {
    expect(
      inboxPageStatusMark(item({ pageStatus: { id: "triage", label: "Incoming" } })),
    ).toBeNull();
    expect(inboxPageStatusMark(item({ pageStatus: { id: "review", label: "Triage" } }))).toEqual({
      id: "review",
      label: "Triage",
    });
  });
});

describe("inboxRowOffers", () => {
  const offers = (model: Parameters<typeof inboxRowOffers>[0], grouped = false) =>
    inboxRowOffers(model, { suggestionsOffered: true, grouped });

  it("names what the row shows, so the menu can leave it out", () => {
    expect(offers({ kind: "undecided" })).toEqual({
      done: true,
      handleManually: true,
      suggest: true,
    });
    expect(offers({ kind: "suggesting" })).toEqual({
      done: true,
      handleManually: true,
      suggest: false,
    });
    expect(offers({ kind: "suggestion-failed", message: "Timed out" })).toEqual({
      done: true,
      handleManually: true,
      suggest: true,
    });
    expect(
      inboxRowOffers({ kind: "undecided" }, { suggestionsOffered: false, grouped: false }).suggest,
    ).toBe(false);
  });

  it("keeps Handle manually in the menu beside a suggestion, where it changes the suggestion", () => {
    const current = { kind: "suggestion", proposal: proposal(), refreshing: false } as const;
    expect(offers({ ...current, refreshError: null })).toEqual({
      done: true,
      handleManually: false,
      suggest: false,
    });
    // An outdated or failed suggestion asks again from the row, so the menu does not.
    expect(
      offers({ ...current, proposal: proposal({ outdated: true }), refreshError: null }).suggest,
    ).toBe(true);
    expect(offers({ ...current, refreshError: "Timed out" }).suggest).toBe(true);
    expect(
      inboxRowOffers(
        { ...current, proposal: proposal({ outdated: true }), refreshError: null },
        { suggestionsOffered: false, grouped: false },
      ).suggest,
    ).toBe(false);
  });

  it("offers nothing beside the menu for a group member or a handled message", () => {
    const nothing = { done: false, handleManually: false, suggest: false };
    expect(
      offers(
        { kind: "suggestion", proposal: proposal(), refreshing: false, refreshError: null },
        true,
      ),
    ).toEqual(nothing);
    expect(offers({ kind: "handled" })).toEqual(nothing);
  });
});

describe("a scheduled task's waiting run", () => {
  const firingSource = {
    kind: "scheduled_task" as const,
    automationId: "automation:deps",
    dispatchId: "dispatch:1",
    projectId: "project:nodex",
    label: "Bump dependency versions",
  };
  const firing = {
    automationId: "automation:deps",
    dispatchId: "dispatch:1",
    status: "held" as const,
    firstScheduledFor: new Date(2026, 9, 26, 9, 0).getTime(),
    lastScheduledFor: new Date(2026, 9, 26, 9, 0).getTime(),
    missedCount: 0,
    failureMessage: null,
  };
  const runTask = proposal({
    origin: "schedule",
    action: {
      type: "run_task",
      automationId: "automation:deps",
      dispatchId: "dispatch:1",
      agent: null,
    },
    kind: "todo",
    summary: "Run Bump dependency versions",
    producedBy: null,
  });
  const waiting = (overrides: Partial<InboxItem> = {}) =>
    item({ source: firingSource, firing, proposal: runTask, ...overrides });

  it("asks to run in its Project, or in its chat for a Heartbeat", () => {
    expect(describeInboxAction(runTask.action, { targetProjectName: "Nodex", chat: null })).toEqual(
      { verb: "Run", target: "Run in Nodex" },
    );
    expect(
      describeInboxAction(runTask.action, { targetProjectName: null, chat: null }).target,
    ).toBe("Run without a Project");
    expect(describeInboxAction(runTask.action, { targetProjectName: null, chat }).target).toBe(
      "Run in “Homepage positioning”",
    );
  });

  it("waits in the Inbox until it runs, and returns when its run fails before reaching a chat", () => {
    expect(inboxTriageModel(waiting(), AUTOMATIC)).toMatchObject({
      kind: "suggestion",
      proposal: runTask,
    });
    const admitted = waiting({
      outcome: "chat",
      firing: { ...firing, status: "admitted" },
      proposal: { ...runTask, state: "completed" },
    });
    expect(isInboxItemHandled(admitted)).toBe(true);
    expect(describeInboxOutcome(admitted)).toMatchObject({
      icon: "pending",
      label: "Starting “Bump dependency versions”",
      inProgress: true,
    });
    const failed = waiting({
      outcome: "chat",
      firing: { ...firing, status: "failed", failureMessage: "The Agent is off" },
      proposal: { ...runTask, state: "failed", failureKind: "rejected", failureMessage: null },
    });
    expect(isInboxItemHandled(failed)).toBe(false);
    expect(inboxTriageModel(failed, AUTOMATIC)).toMatchObject({
      kind: "dispatch-failed",
      message: "The Agent is off",
    });
  });

  it("follows its run's chat in History as soon as the run reaches one", () => {
    // The firing stays admitted while its run works; the chat's own status tells how it goes.
    const ran = waiting({
      outcome: "chat",
      firing: { ...firing, status: "admitted" },
      proposal: { ...runTask, state: "completed", chat },
    });
    expect(describeInboxOutcome(ran)).toMatchObject({
      icon: "chat",
      label: "Ran “Bump dependency versions”",
      open: { kind: "session", sessionId: "session:1" },
      status: { label: "New reply" },
      inProgress: true,
    });
  });

  it("reads as skipped when the user marks it done instead of running it", () => {
    const skipped = waiting({
      state: "done",
      outcome: "done",
      firing: { ...firing, status: "skipped" },
    });
    expect(describeInboxOutcome(skipped).label).toBe("Skipped");
    expect(describeInboxDecision(waiting(), { kind: "done" }).label).toBe("Skipped");
    expect(describeInboxDecision(waiting(), { kind: "run", taskName: "Deps" })).toMatchObject({
      icon: "pending",
      label: "Starting “Deps”",
    });
  });

  it("can no longer run once its task is deleted", () => {
    expect(
      inboxTriageModel(waiting({ firing: { ...firing, status: "withdrawn" } }), AUTOMATIC),
    ).toEqual({
      kind: "firing-withdrawn",
    });
  });

  it("says when it fell due, how often since, and where it runs", () => {
    const now = new Date(2026, 9, 27, 12, 0);
    const task = {
      kind: "cron" as const,
      projectId: "project:nodex",
      executionEnvironment: "worktree" as const,
      cwds: ["/repo"],
    };
    expect(describeInboxFiring(firing, task, now)).toMatch(/^Due Yesterday, .+ · Worktree$/u);
    expect(describeInboxFiring({ ...firing, missedCount: 2 }, task, now)).toMatch(
      /^Due 3 times since Yesterday, .+ · Worktree$/u,
    );
    expect(
      describeInboxFiring(firing, { ...task, kind: "heartbeat" as const, projectId: null }, now),
    ).toMatch(/· Continues its chat$/u);
    expect(describeInboxFiring(firing, null, now)).toMatch(/^Due Yesterday, /u);
  });
});
