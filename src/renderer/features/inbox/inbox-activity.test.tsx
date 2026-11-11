import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import { TestQueryProvider } from "@/test/query";
import type { ActivityFilter, ActivityRow, InboxChat, InboxItem } from "../../../shared/inbox";
import { InboxActivity, InboxActivityFilters, type InboxActivityHandlers } from "./inbox-activity";

const external = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/file-system-operations", () => ({ openExternalUrl: external }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const fact = (overrides: Partial<ActivityRow>): ActivityRow => ({
  id: "note:one",
  at: "2026-11-06T00:30:00Z",
  actor: { type: "service", kind: "inbox_routing" },
  actor_label: "by Nodex",
  subject: { kind: "page", page_id: "page", label: "NODEX-3" },
  description: "Noted on NODEX-3",
  reason: "Ready for review",
  page_id: "page",
  session_id: null,
  url: null,
  evidence: {},
  category: "all",
  message: null,
  ...overrides,
});

const chat = (overrides: Partial<InboxChat> = {}): InboxChat => ({
  sessionId: "session:1",
  projectId: null,
  projectName: null,
  displayTitle: "Fix the readme typo",
  threadId: "thread:1",
  executionRef: null,
  status: { statusType: "idle", activeFlags: [] },
  unread: false,
  archived: false,
  ...overrides,
});

const message = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  pageId: "page:1",
  rowKind: "intake",
  later: null,
  turn: null,
  basis: { pageId: "page:1", contentHash: "content:1" },
  pageKey: "IN-1",
  pageStatus: null,
  title: "Fix the readme typo",
  body: "The README says “recieve”.",
  bodyTruncated: false,
  bodyEditable: true,
  submittedAt: "2026-11-06T00:00:00.000Z",
  source: { kind: "user" },
  replyToPageId: null,
  kind: "todo",
  important: false,
  waiting: true,
  suggestionState: "settled",
  suggestionError: null,
  automationDecision: null,
  scope: { kind: "library" },
  location: { kind: "inbox" },
  proposal: null,
  revision: 1,
  ...overrides,
});

const sent = (item: Partial<InboxItem> = {}, status: InboxChat["status"] = null) =>
  fact({
    id: "message:1",
    actor: { type: "member", member_id: "local" },
    actor_label: "by You",
    description: "Sent “Fix the readme typo” to “Fix the readme typo”",
    reason: "A small docs fix for the open docs chat",
    subject: { kind: "chat", session_id: "session:1", label: "Fix the readme typo" },
    page_id: "page:1",
    session_id: "session:1",
    category: "messages",
    message: message({
      proposal: {
        proposalId: "proposal:1",
        revision: 3,
        origin: "agent",
        state: "completed",
        pageIds: ["page:1"],
        basis: [{ pageId: "page:1", contentHash: "content:1" }],
        outdated: false,
        explicitRequest: false,
        confirmedBy: "user",
        action: { type: "send_to_chat", sessionId: "session:1", prompt: "Fix it.", additions: [] },
        kind: "todo",
        summary: "Send to the docs chat",
        rationale: "A small docs fix for the open docs chat",
        producedBy: "Codex",
        targetProjectName: null,
        chat: chat(status ? { status } : {}),
        failureMessage: null,
        failureKind: null,
        createdAt: "2026-11-06T00:00:00.000Z",
        updatedAt: "2026-11-06T00:00:00.000Z",
      },
      ...item,
    }),
  });

const handlers = (): InboxActivityHandlers => ({
  onOpenPage: vi.fn(),
  onOpenSession: vi.fn(),
  onOpenAutomation: vi.fn(),
  onOpenGitHubSettings: vi.fn(),
  onOpenTarget: vi.fn(),
  onReturn: vi.fn(),
  onSetDone: vi.fn(),
  onDelete: vi.fn(),
});

const show = (
  rows: readonly ActivityRow[],
  actions: InboxActivityHandlers = handlers(),
  options: { filter?: ActivityFilter; arrival?: { pageId: string; token: number } } = {},
) => {
  const view = (arrival = options.arrival ?? { pageId: "", token: 0 }) => (
    <TestQueryProvider>
      <InboxActivity rows={rows} filter={options.filter ?? "all"} arrival={arrival} {...actions} />
    </TestQueryProvider>
  );
  const rendered = render(view());
  return {
    ...rendered,
    actions,
    rerenderWith: (arrival: { pageId: string; token: number }) => rendered.rerender(view(arrival)),
  };
};

const press = async (element: HTMLElement) => {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
};

describe("Activity", () => {
  test("expands a fact to its reason and evidence links", async () => {
    const row = fact({
      id: "problem:one",
      subject: {
        kind: "thread",
        url: "https://github.com/alice/repo/issues/7",
        label: "alice/repo #7",
      },
      description: "GitHub reply needs attention",
      reason: "The origin thread is locked",
      page_id: "card",
      session_id: "chat",
      url: "https://github.com/alice/repo/issues/7",
      category: "problems",
    });
    const { actions } = show([row]);
    const line = screen.getByRole("button", { name: /GitHub reply needs attention/ });
    expect(line.getAttribute("aria-expanded")).toBe("false");
    await press(line);
    expect(line.getAttribute("aria-expanded")).toBe("true");
    await press(screen.getByRole("button", { name: "Open card" }));
    await press(screen.getByRole("button", { name: "Open chat" }));
    await press(screen.getByRole("button", { name: "Open on GitHub" }));
    expect(actions.onOpenPage).toHaveBeenCalledWith("card");
    expect(actions.onOpenSession).toHaveBeenCalledWith("chat");
    expect(external).toHaveBeenCalledWith(row.url);
  });

  test("a GitHub problem without a card opens GitHub settings", async () => {
    const { actions } = show([
      fact({
        id: "problem-open:source",
        subject: { kind: "source", source_id: "github", label: "GitHub" },
        description: "GitHub could not be checked",
        reason: "Unreachable for 3 checks",
        page_id: null,
        category: "problems",
      }),
    ]);
    await press(screen.getByRole("button", { name: "GitHub" }));
    await press(screen.getByRole("button", { name: /GitHub could not be checked/ }));
    await press(screen.getByRole("button", { name: "GitHub settings" }));
    expect(actions.onOpenGitHubSettings).toHaveBeenCalledTimes(2);
  });

  test("a handled message expands to its words, reason and the ways back to its work", async () => {
    const { actions } = show([
      sent({}, { statusType: "active", activeFlags: ["waitingOnApproval"] }),
    ]);
    // The chat it went to says it is waiting while the work is under way.
    expect(screen.getByRole("button", { name: "Fix the readme typo" })).toBeTruthy();
    await press(screen.getByRole("button", { name: /Sent “Fix the readme typo”/ }));
    expect(screen.getByText("The README says “recieve”.")).toBeTruthy();
    expect(screen.getAllByText("A small docs fix for the open docs chat")).toHaveLength(2);
    expect(screen.getByText("IN-1")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Open chat" }));
    expect(actions.onOpenTarget).toHaveBeenCalledWith({ kind: "session", sessionId: "session:1" });
    // Work handed to a chat uses the Page’s work actions.
    expect(screen.queryByRole("button", { name: "Return to Inbox" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
  });

  test("a message added to Todo can return to the Inbox or be deleted", async () => {
    const kept = message({ waiting: false, pageStatus: { id: "plan", label: "Todo" } });
    const { actions } = show([
      fact({
        id: "message:2",
        description: "Added “Fix the readme typo” to Todo",
        reason: null,
        page_id: "page:1",
        category: "messages",
        message: kept,
      }),
    ]);
    await press(screen.getByRole("button", { name: /Added “Fix the readme typo” to Todo/ }));
    expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
    await press(screen.getByRole("button", { name: "Return to Inbox" }));
    expect(actions.onReturn).toHaveBeenCalledWith("page:1");
    await press(screen.getByRole("button", { name: "Delete" }));
    expect(actions.onDelete).toHaveBeenCalledWith(kept);
  });

  test("a navigation opens the newest line about its message", async () => {
    const older = sent();
    const newer = fact({
      ...older,
      id: "message:3",
      description: "Marked “Fix the readme typo” done",
      at: "2026-11-06T01:00:00Z",
    });
    const view = show([newer, older]);
    const lines = () => screen.getAllByRole("button", { expanded: true });
    expect(screen.queryAllByRole("button", { expanded: true })).toHaveLength(0);
    await act(async () => {
      view.rerenderWith({ pageId: "page:1", token: 1 });
      await Promise.resolve();
    });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]!.textContent).toContain("Marked “Fix the readme typo” done");
  });

  test.each([
    ["all", "Messages you handle"],
    ["messages", "Messages you send to chats, file, keep, or finish collect here."],
    ["decisions", "What Nodex and your Automations decide collects here."],
    ["problems", "Problems with GitHub"],
  ] as const)("says what collects under %s while it is empty", (filter, description) => {
    show([], handlers(), { filter });
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
    expect(screen.getByText(new RegExp(description))).toBeTruthy();
  });

  test("groups facts by day, newest first", () => {
    show([
      fact({ id: "note:new", at: "2026-11-06T12:00:00", description: "Noted on NODEX-4" }),
      fact({ id: "note:old", at: "2026-11-05T12:00:00", description: "Noted on NODEX-3" }),
    ]);
    const days = screen.getAllByRole("region");
    expect(days).toHaveLength(2);
    expect(within(days[0]!).getByText("Noted on NODEX-4")).toBeTruthy();
    expect(within(days[1]!).getByText("Noted on NODEX-3")).toBeTruthy();
  });
});

test("filters name the messages and Nodex's own decisions", async () => {
  const onChange = vi.fn();
  render(<InboxActivityFilters filter="all" onChange={onChange} />);
  expect(
    screen.getAllByRole("button").map((button) => [button.textContent, button.ariaPressed]),
  ).toEqual([
    ["All", "true"],
    ["Messages", "false"],
    ["Nodex & automations", "false"],
    ["Problems", "false"],
  ]);
  await press(screen.getByRole("button", { name: "Nodex & automations" }));
  expect(onChange).toHaveBeenCalledWith("decisions");
});

const actors = [
  { actor: { type: "member", member_id: "alice" }, label: "by Alice" },
  { actor: { type: "member", member_id: "local" }, label: "by You" },
  {
    actor: { type: "agent", session_id: "chat", run_id: "run", on_behalf_of: "alice" },
    label: "by Codex on behalf of Alice",
  },
  { actor: { type: "service", kind: "sources" }, label: "by GitHub" },
] satisfies { actor: ActivityRow["actor"]; label: string }[];

test.each(actors)("exposes $label on an Activity fact", ({ actor, label }) => {
  show([fact({ actor, actor_label: label })]);
  expect(screen.getByRole("img", { name: label })).toBeTruthy();
});

const subjects = [
  { kind: "page", page_id: "page", label: "NODEX-3" },
  { kind: "page", page_id: "page", label: "Fix navigation" },
  { kind: "chat", session_id: "chat", label: "Keyboard navigation" },
  { kind: "automation", automation_id: "automation", label: "Morning review" },
  { kind: "thread", url: "https://github.com/owner/repo/pull/7", label: "owner/repo #7" },
  { kind: "source", source_id: "github", label: "GitHub" },
] satisfies NonNullable<ActivityRow["subject"]>[];

test.each(subjects)("opens the named $kind subject: $label", async (subject) => {
  const { actions } = show([fact({ subject })]);
  await press(screen.getByRole("button", { name: subject.label }));
  if (subject.kind === "page") expect(actions.onOpenPage).toHaveBeenCalledWith(subject.page_id);
  if (subject.kind === "chat") {
    expect(actions.onOpenSession).toHaveBeenCalledWith(subject.session_id);
  }
  if (subject.kind === "automation") {
    expect(actions.onOpenAutomation).toHaveBeenCalledWith(subject.automation_id);
    expect(actions.onOpenGitHubSettings).not.toHaveBeenCalled();
  }
  if (subject.kind === "thread") expect(external).toHaveBeenCalledWith(subject.url);
  if (subject.kind === "source") expect(actions.onOpenGitHubSettings).toHaveBeenCalledOnce();
});
