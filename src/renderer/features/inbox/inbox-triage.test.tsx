import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { openNodexMenu, render } from "@/test/dom";
import { TestQueryProvider } from "@/test/query";
import type { InboxChat, InboxItem, InboxProposal } from "../../../shared/inbox";
import type { Project } from "../../../shared/types";
import { InboxDeleteDialog } from "./inbox-delete-dialog";
import { draftForInboxItem } from "./inbox-dispatch-editor";
import { describeInboxDecision } from "./inbox-presentation";
import { InboxHistory } from "./inbox-history";
import { InboxMessage, InboxMessageMenu, type InboxMessageMenuHandlers } from "./inbox-message";
import { NO_ROW_OFFERS } from "./inbox-presentation";
import { InboxTriage } from "./inbox-triage";
import type { InboxActions } from "./use-inbox-actions";
import { CLAUDE_INSTANCE_ID, inboxAgentsFixture } from "./inbox-agents.test-support";

const project = (id: string, name: string): Project =>
  ({ id, name, lifecycle: "active", databaseId: `db:${id}` }) as Project;

const proposal = (overrides: Partial<InboxProposal> = {}): InboxProposal => ({
  proposalId: "proposal:1",
  revision: 2,
  origin: "agent",
  state: "open",
  pageIds: ["page:1"],
  basis: [{ pageId: "page:1", contentHash: "content:1" }],
  outdated: false,
  action: {
    type: "new_chat",
    projectId: "project:nodex",
    prompt: "Compare both positions.",
    agent: null,
    delegates: [],
    plan: null,
  },
  kind: "question",
  summary: "Compare both homepage positions first.",
  rationale: "Still an open question.",
  producedBy: "Codex",
  targetProjectName: "Nodex",
  chat: null,
  failureMessage: null,
  failureKind: null,
  createdAt: "2026-10-11T10:00:00.000Z",
  updatedAt: "2026-10-11T10:00:00.000Z",
  ...overrides,
});

const item = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  pageId: "page:1",
  outcome: null,
  basis: { pageId: "page:1", contentHash: "content:1" },
  pageKey: "IN-1",
  pageStatus: null,
  title: "Homepage positioning",
  body: "Homepage feels like a dev tool",
  bodyTruncated: false,
  bodyEditable: true,
  submittedAt: "2026-10-11T10:00:00.000Z",
  source: { kind: "user" },
  kind: "question",
  important: false,
  state: "open",
  suggestionState: "settled",
  suggestionError: null,
  firing: null,
  scope: { kind: "library" },
  location: { kind: "inbox" },
  proposal: proposal(),
  revision: 1,
  ...overrides,
});

const actions = (): InboxActions => ({
  send: vi.fn(async () => ({ pageId: "page:1", state: "saved" as const })),
  pendingDecisions: [],
  retryDecision: vi.fn(async () => true),
  forgetDecision: vi.fn(async () => true),
  edit: vi.fn(async () => true),
  confirm: vi.fn(async () => true),
  dispatch: vi.fn(async () => true),
  keep: vi.fn(async () => true),
  delete: vi.fn(async () => true),
  setState: vi.fn(async () => true),
  setKind: vi.fn(async () => true),
  setImportant: vi.fn(async () => true),
  requestSuggestion: vi.fn(async () => true),
  retryDispatch: vi.fn(async () => true),
});

/** Whether the last rendered row already opens the message's chat. */
let rowOpensChat = false;

const renderTriage = (
  overrides: Partial<Parameters<typeof InboxTriage>[0]> = {},
  commands: InboxActions = actions(),
) => {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <InboxTriage
        item={item()}
        projects={[project("project:nodex", "Nodex"), project("project:site", "Site")]}
        agents={inboxAgentsFixture()}
        policy={{ kind: "automatic" }}
        actions={commands}
        manualDraft={null}
        groupedWithKey={null}
        inboxProjectId={null}
        menu={() => null}
        onManualDraftChange={vi.fn()}
        {...overrides}
      >
        {({ editor, messageActions, strip, actions: row, opensChat }) => {
          rowOpensChat = opensChat;
          return (
            <>
              {editor ?? <p>{overrides.item?.body ?? item().body}</p>}
              {messageActions}
              {strip}
              {row}
            </>
          );
        }}
      </InboxTriage>
    </QueryClientProvider>,
  );
  return commands;
};

/** The row's recommended step is the last button in it. */
const lastButtonName = () => {
  const last = screen.getAllByRole("button").at(-1);
  return last?.getAttribute("aria-label") ?? last?.textContent?.trim() ?? null;
};

const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await Promise.resolve();
  });
};

describe("InboxTriage", () => {
  test.each(["open", "failed", "dispatching"] as const)(
    "reviewing a %s group keeps all sources and only confirms an open proposal",
    (state) => {
      const grouped = proposal({
        state,
        failureKind: state === "dispatching" ? "unknown" : null,
        pageIds: ["page:1", "page:2"],
        basis: [item().basis, { pageId: "page:2", contentHash: "content:3" }],
      });
      const draft = draftForInboxItem(item({ proposal: grouped }), null);
      expect(draft.basis).toEqual(grouped.basis);
      expect(draft.prompt).toBe("Compare both positions.");
      expect(draft.proposal).toEqual(state === "open" ? grouped : undefined);
    },
  );

  test("a message waiting for advice shows a spinner until its decision takes that place", async () => {
    const waiting = item({ kind: null, suggestionState: "pending", proposal: null });
    const onManualDraftChange = vi.fn();
    const { unmount } = render(
      <QueryClientProvider client={new QueryClient()}>
        <InboxTriage
          item={waiting}
          projects={[]}
          agents={inboxAgentsFixture()}
          policy={{ kind: "automatic" }}
          awaitingIndicator
          actions={actions()}
          manualDraft={null}
          groupedWithKey={null}
          inboxProjectId={null}
          menu={() => null}
          onManualDraftChange={onManualDraftChange}
        >
          {({ strip, actions: row }) => (
            <>
              {strip === null ? null : <div data-testid="strip">{strip}</div>}
              {row}
            </>
          )}
        </InboxTriage>
      </QueryClientProvider>,
    );
    expect(screen.getByRole("status", { name: "Finding where this goes" })).toBeTruthy();
    expect(screen.queryByTestId("strip")).toBeNull();
    // Someone who would rather not wait can decide by hand right away.
    await click("Handle manually");
    expect(onManualDraftChange).toHaveBeenCalledWith(draftForInboxItem(waiting, null));
    unmount();

    renderTriage({ item: item({ suggestionState: "settled" }), awaitingIndicator: true });
    expect(screen.queryByRole("status", { name: "Finding where this goes" })).toBeNull();
    expect(screen.getByRole("button", { name: "New chat in Nodex" })).toBeTruthy();
  });

  test("a manual decision before advice arrives stays inside its Project Inbox", () => {
    expect(draftForInboxItem(item({ proposal: null }), "project:nodex")).toMatchObject({
      type: "new_chat",
      projectId: "project:nodex",
    });
  });

  test("keeps the opening edit basis when another view changes the message", async () => {
    const commands = { ...actions(), edit: vi.fn(async () => false) };
    const view = (message: InboxItem) => (
      <InboxTriage
        item={message}
        projects={[]}
        agents={inboxAgentsFixture()}
        inboxProjectId={null}
        policy={{ kind: "automatic" }}
        actions={commands}
        manualDraft={null}
        groupedWithKey={null}
        menu={() => null}
        onManualDraftChange={vi.fn()}
      >
        {({ editor, messageActions, strip, actions: controls }) => (
          <>
            {editor ?? message.body}
            {messageActions}
            {strip}
            {controls}
          </>
        )}
      </InboxTriage>
    );
    const rendered = render(<TestQueryProvider>{view(item({ body: "A" }))}</TestQueryProvider>);
    await click("Edit");
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: "Edit message" }), {
        target: { value: "B" },
      });
    });
    rendered.rerender(
      <TestQueryProvider>
        {view(
          item({
            body: "C",
            basis: { pageId: "page:1", contentHash: "content:2" },
          }),
        )}
      </TestQueryProvider>,
    );
    await click("Save");
    await waitFor(() =>
      expect(commands.edit).toHaveBeenCalledWith("page:1", "A", "B", item().basis),
    );
    expect(
      (screen.getByRole("textbox", { name: "Edit message" }) as HTMLTextAreaElement).value,
    ).toBe("B");
    expect(screen.getByText("C")).toBeTruthy();
  });

  test("a scheduled task's waiting run runs in its Project, or is skipped, never kept", async () => {
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
      rationale: null,
      producedBy: null,
    });
    const commands = renderTriage({
      item: item({
        kind: "todo",
        source: {
          kind: "scheduled_task",
          automationId: "automation:deps",
          dispatchId: "dispatch:1",
          projectId: "project:nodex",
          label: "Bump dependency versions",
        },
        firing: {
          automationId: "automation:deps",
          dispatchId: "dispatch:1",
          status: "held",
          firstScheduledFor: Date.parse("2026-10-26T09:00:00.000Z"),
          lastScheduledFor: Date.parse("2026-10-26T09:00:00.000Z"),
          missedCount: 0,
          failureMessage: null,
        },
        proposal: runTask,
      }),
    });
    // The strip says when it fell due; the instructions are the message itself.
    expect(screen.getByTestId("inbox-suggestion").textContent).toMatch(/^Due /u);
    expect(screen.queryByRole("button", { name: "Keep" })).toBeNull();
    await click("Run in Nodex");
    await waitFor(() => expect(commands.confirm).toHaveBeenCalledWith(runTask));
    await click("Skip this run");
    await waitFor(() => expect(commands.setState).toHaveBeenCalledWith(["page:1"], "done"));
  });

  test("a note gets a concrete Keep decision without asking the user to dispatch", async () => {
    const note = proposal({
      action: { type: "keep" },
      kind: "note",
      summary: "Keep the navigation reference",
    });
    const commands = renderTriage({
      item: item({
        kind: "note",
        proposal: note,
      }),
    });
    expect(screen.getByText("Keep the navigation reference")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Handle manually" })).toBeNull();
    expect(commands.confirm).not.toHaveBeenCalled();
    await click("Keep");
    await waitFor(() => expect(commands.confirm).toHaveBeenCalledWith(note));
    expect(commands.dispatch).not.toHaveBeenCalled();
  });

  test("unknown remote delivery offers checking the chat before an explicit new send", async () => {
    const onOpenSession = vi.fn();
    const onManualDraftChange = vi.fn();
    const failed = proposal({
      state: "dispatching",
      failureKind: "unknown",
      failureMessage: "Check the destination chat",
      chat: {
        sessionId: "session:remote",
        displayTitle: "Remote chat",
        projectId: null,
        projectName: null,
        threadId: null,
        executionRef: null,
        status: null,
        unread: false,
        archived: false,
      },
    });
    const commands = renderTriage({
      item: item({ proposal: failed }),
      onOpenSession,
      onManualDraftChange,
    });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    // Checking the chat is the recommended step, so it ends the row.
    expect(lastButtonName()).toBe("Open chat");
    // The row is where the chat is checked, so the message does not offer it a second time.
    expect(rowOpensChat).toBe(true);
    await click("Open chat");
    expect(onOpenSession).toHaveBeenCalledWith("session:remote");
    await click("Send again");
    expect(onManualDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ basis: failed.basis }),
    );
    expect(commands.retryDispatch).not.toHaveBeenCalled();
    expect(commands.dispatch).not.toHaveBeenCalled();
  });

  test("a rejected handoff requires a new reviewed decision", async () => {
    const onManualDraftChange = vi.fn();
    const commands = renderTriage({
      item: item({
        proposal: proposal({
          state: "failed",
          failureKind: "rejected",
          failureMessage: "Target is archived",
        }),
      }),
      onManualDraftChange,
    });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(lastButtonName()).toBe("Handle manually");
    await click("Handle manually");
    expect(onManualDraftChange).toHaveBeenCalled();
    expect(commands.retryDispatch).not.toHaveBeenCalled();
  });

  test("a delivery that can be tried again ends its row with Retry, beside Handle manually", async () => {
    const commands = renderTriage({
      item: item({
        proposal: proposal({
          state: "failed",
          failureKind: "unavailable",
          failureMessage: "Codex is not running",
        }),
      }),
    });
    expect(lastButtonName()).toBe("Retry");
    expect(screen.getByRole("button", { name: "Handle manually" })).toBeTruthy();
    await click("Retry");
    await waitFor(() => expect(commands.retryDispatch).toHaveBeenCalledWith("proposal:1"));
  });

  test("removing a member refines the remaining group without deleting any message", async () => {
    const grouped = proposal({
      pageIds: ["page:1", "page:2"],
      basis: [item().basis, { ...item().basis, pageId: "page:2" }],
    });
    const commands = renderTriage({
      item: item({ proposal: grouped }),
      members: [
        { pageId: "page:1", label: "IN-1", preview: "First" },
        { pageId: "page:2", label: "IN-2", preview: "Second" },
      ],
    });
    await act(async () => {
      fireEvent.click(screen.getByText("2 messages"));
      await Promise.resolve();
    });
    await screen.findByRole("button", { name: "Remove IN-2 from suggestion" });
    await click("Remove IN-2 from suggestion");
    expect(commands.requestSuggestion).toHaveBeenCalledWith(["page:1"], [item().basis], {
      proposal: grouped,
      correction: expect.any(String),
    });
    expect(commands.delete).not.toHaveBeenCalled();
    expect(commands.confirm).not.toHaveBeenCalled();
  });

  test("confirms the exact suggested action and nothing else", async () => {
    const commands = renderTriage();
    // A chat suggestion reads as the prompt it will send; its summary waits on the decision.
    expect(screen.getByText("Compare both positions.")).toBeTruthy();
    expect(screen.queryByText("Compare both homepage positions first.")).toBeNull();
    // The exact destination is visible before confirming.
    // A kind only steers suggestions, so the card never shows it.
    expect(screen.queryByRole("button", { name: /^Kind/ })).toBeNull();
    expect(screen.getByRole("button", { name: "New chat in Nodex" })).toBeTruthy();
    await click("New chat in Nodex");
    await waitFor(() => expect(commands.confirm).toHaveBeenCalledWith(proposal()));
    expect(commands.dispatch).not.toHaveBeenCalled();
  });

  test("a new chat says what it runs on, apart from the Agent that suggested it", async () => {
    renderTriage({ item: item({ proposal: proposal({ producedBy: "Codex · GPT-6.1 Sol" }) }) });
    await act(async () => {
      screen.getByRole("button", { name: "New chat in Nodex" }).focus();
      await Promise.resolve();
    });
    const tooltip = within(await screen.findByRole("tooltip"));
    expect(tooltip.getByText("Codex · GPT-6 Astra · Medium")).toBeTruthy();
    expect(tooltip.getByText("Suggested by Codex · GPT-6.1 Sol")).toBeTruthy();
  });

  test("starts one suggestion's chat on another model without changing the Inbox's own", async () => {
    const agents = inboxAgentsFixture();
    const commands = renderTriage({ agents });
    await click("Choose the model for this chat");
    const model = await screen.findByRole("option", { name: /Opus 5\.5/ });
    await act(async () => {
      fireEvent.click(model);
      await Promise.resolve();
    });
    // A choice that differs from the Inbox's own stays on the decision.
    const menu = screen.getByRole("button", { name: "Choose the model for this chat" });
    await waitFor(() => expect(menu.textContent).toContain("Opus 5.5 · High"));
    await click("New chat in Nodex");
    await waitFor(() =>
      expect(commands.confirm).toHaveBeenCalledWith(proposal(), {
        ...proposal().action,
        agent: {
          instanceId: CLAUDE_INSTANCE_ID,
          model: "claude-opus-5-5",
          reasoningEffort: null,
          serviceTier: null,
        },
      }),
    );
    expect(agents.save).not.toHaveBeenCalled();
  });

  test("a planned suggestion shows its lead, the parts it hands off and its plan, and confirms them as suggested", async () => {
    const opus = {
      instanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-5-5",
      reasoningEffort: "high",
      serviceTier: null,
    };
    const planned = proposal({
      action: {
        type: "new_chat",
        projectId: "project:nodex",
        prompt: "Build the usage dashboard.",
        agent: opus,
        delegates: [
          {
            work: "The aggregation API and its SQLite queries",
            agent: {
              instanceId: "codex",
              model: "gpt-6-luna",
              reasoningEffort: null,
              serviceTier: null,
            },
          },
        ],
        plan: "Settle the API contract first.",
      },
    });
    const commands = renderTriage({ item: item({ proposal: planned }) });
    // The suggestion's lead differs from the Inbox's own, so it shows on the decision.
    expect(
      screen.getByRole("button", { name: "Choose the model for this chat" }).textContent,
    ).toContain("Work · Opus 5.5 · High");
    const plan = within(screen.getByTestId("inbox-chat-plan"));
    expect(plan.getByText("The aggregation API and its SQLite queries")).toBeTruthy();
    expect(plan.getByText("GPT-6 Luna")).toBeTruthy();
    expect(plan.getByText("Settle the API contract first.")).toBeTruthy();
    await click("New chat in Nodex");
    await waitFor(() => expect(commands.confirm).toHaveBeenCalledWith(planned));
  });

  test("handling a planned suggestion by hand can drop a delegated part and rewrite the plan", async () => {
    const planned = proposal({
      action: {
        type: "new_chat",
        projectId: "project:nodex",
        prompt: "Build the usage dashboard.",
        agent: null,
        delegates: [
          {
            work: "The aggregation API",
            agent: {
              instanceId: "codex",
              model: "gpt-6-luna",
              reasoningEffort: null,
              serviceTier: null,
            },
          },
        ],
        plan: "Settle the API contract first.",
      },
    });
    const commands = renderTriage({
      manualDraft: draftForInboxItem(item({ proposal: planned }), null),
    });
    await click("Do “The aggregation API” without delegating");
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: "Plan" }), {
        target: { value: "Build it all in this chat." },
      });
      await Promise.resolve();
    });
    await click("Start chat");
    await waitFor(() =>
      expect(commands.confirm).toHaveBeenCalledWith(
        planned,
        { ...planned.action, delegates: [], plan: "Build it all in this chat." },
        null,
      ),
    );
  });

  test("Edit rewrites the message itself and asks nothing to run", async () => {
    const commands = renderTriage();
    await click("Edit");
    const editor = await screen.findByRole("textbox", { name: "Edit message" });
    expect((editor as HTMLTextAreaElement).value).toBe("Homepage feels like a dev tool");
    // What Nodex made of the old text steps aside while it is rewritten.
    expect(screen.queryByText("Compare both positions.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start chat" })).toBeNull();
    await act(async () => {
      fireEvent.change(editor, { target: { value: "Homepage should read like an assistant" } });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(editor, { key: "Enter" });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(commands.edit).toHaveBeenCalledWith(
        "page:1",
        "Homepage feels like a dev tool",
        "Homepage should read like an assistant",
        { pageId: "page:1", contentHash: "content:1" },
      ),
    );
    expect(await screen.findByText("Compare both positions.")).toBeTruthy();
    expect(commands.confirm).not.toHaveBeenCalled();
    expect(commands.dispatch).not.toHaveBeenCalled();
  });

  test("an edit that fails to save stays open, and Escape restores the message", async () => {
    const commands = { ...actions(), edit: vi.fn(async () => false) };
    renderTriage({}, commands);
    await click("Edit");
    const editor = await screen.findByRole("textbox", { name: "Edit message" });
    // Unchanged text has nothing to save.
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      fireEvent.change(editor, { target: { value: "A different thought" } });
      await Promise.resolve();
    });
    await click("Save");
    await waitFor(() => expect(commands.edit).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("textbox", { name: "Edit message" })).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit message" }), { key: "Escape" });
      await Promise.resolve();
    });
    expect(screen.queryByRole("textbox", { name: "Edit message" })).toBeNull();
    expect(screen.getByText("Homepage feels like a dev tool")).toBeTruthy();
  });

  test("a hand-written dispatch from the suggestion sends the edited action", async () => {
    const grouped = proposal({
      pageIds: ["page:1", "page:2"],
      basis: [item().basis, { ...item().basis, pageId: "page:2" }],
    });
    const commands = renderTriage({
      manualDraft: draftForInboxItem(item({ proposal: grouped }), null),
    });
    expect(screen.getByText("2 messages")).toBeTruthy();
    const prompt = await screen.findByRole("textbox", { name: "Prompt" });
    await act(async () => {
      fireEvent.change(prompt, { target: { value: "Only list the trade-offs." } });
      await Promise.resolve();
    });
    await click("Start chat");
    await waitFor(() =>
      expect(commands.confirm).toHaveBeenCalledWith(
        grouped,
        {
          type: "new_chat",
          projectId: "project:nodex",
          prompt: "Only list the trade-offs.",
          agent: null,
          delegates: [],
          plan: null,
        },
        null,
      ),
    );
  });

  test("a message just sent to a chat shows where it went in place of its suggestion", async () => {
    const onOpenSession = vi.fn();
    renderTriage({
      onOpenSession,
      decided: describeInboxDecision(item(), {
        kind: "chat",
        type: "new_chat",
        sessionId: "session:new",
        chatTitle: null,
        projectName: "Nodex",
      }),
    });
    expect(screen.getByText("Starting a chat in Nodex")).toBeTruthy();
    // What was suggested, and the ways to decide it, are gone: it has been decided.
    expect(screen.queryByText("Compare both positions.")).toBeNull();
    expect(screen.queryByRole("button", { name: /Start chat/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(rowOpensChat).toBe(true);
    await click("Open chat");
    expect(onOpenSession).toHaveBeenCalledWith("session:new");
  });

  test("keep and done clear the message without dispatching it", async () => {
    const commands = renderTriage();
    // Nothing in this row opens a chat, so the message may offer its own linked chats.
    expect(rowOpensChat).toBe(false);
    await click("Keep");
    await waitFor(() => expect(commands.keep).toHaveBeenCalledWith(["page:1"]));
    await click("Mark done");
    await waitFor(() => expect(commands.setState).toHaveBeenCalledWith(["page:1"], "done"));
    expect(commands.confirm).not.toHaveBeenCalled();
  });

  test("a failed suggestion offers retry and a manual dispatch", async () => {
    const onManualDraftChange = vi.fn();
    const commands = renderTriage({
      onManualDraftChange,
      item: item({
        proposal: null,
        suggestionState: "failed",
        suggestionError: "Sign in to the suggestion agent first",
      }),
    });
    expect(screen.getByText(/Sign in to the suggestion agent first/)).toBeTruthy();
    // Asking again ends the row; deciding by hand is the labeled alternative beside it.
    expect(lastButtonName()).toBe("Retry");
    await click("Retry");
    await waitFor(() =>
      expect(commands.requestSuggestion).toHaveBeenCalledWith(["page:1"], [item().basis]),
    );
    await click("Handle manually");
    expect(onManualDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "new_chat",
        prompt: "Homepage feels like a dev tool",
        agent: null,
        delegates: [],
        plan: null,
      }),
    );
  });

  test("an outdated suggestion stays confirmable and asks again only when told to", async () => {
    const outdated = proposal({
      outdated: true,
      basis: [{ pageId: "page:1", contentHash: "content:2" }],
    });
    const commands = renderTriage({ item: item({ proposal: outdated }) });
    expect(screen.getByText("Suggested before this message changed")).toBeTruthy();
    // Asking again is the obvious next step, so it ends the row where the decision usually does.
    expect(screen.getAllByRole("button").at(-1)?.getAttribute("aria-label")).toBe("Suggest again");
    // The user reviews the prompt as it reads now, and may still send it.
    await click("New chat in Nodex");
    await waitFor(() => expect(commands.confirm).toHaveBeenCalledWith(outdated));
    await click("Suggest again");
    await waitFor(() =>
      expect(commands.requestSuggestion).toHaveBeenCalledWith(["page:1"], outdated.basis),
    );
  });

  test("new advice for an outdated suggestion runs beside it, then reports a failure there", () => {
    const outdated = proposal({ outdated: true });
    const { unmount } = render(
      <TestQueryProvider>
        <InboxTriage
          item={item({ proposal: outdated, suggestionState: "pending" })}
          projects={[project("project:nodex", "Nodex")]}
          agents={inboxAgentsFixture()}
          policy={{ kind: "on_request" }}
          actions={actions()}
          manualDraft={null}
          groupedWithKey={null}
          inboxProjectId={null}
          menu={() => null}
          onManualDraftChange={vi.fn()}
        >
          {({ strip, actions: row }) => (
            <>
              {strip}
              {row}
            </>
          )}
        </InboxTriage>
      </TestQueryProvider>,
    );
    expect(screen.getByRole("status", { name: "Finding where this goes" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Suggest again" })).toBeNull();
    expect(screen.getByRole("button", { name: "New chat in Nodex" })).toBeTruthy();
    unmount();

    renderTriage({
      item: item({
        proposal: outdated,
        suggestionState: "failed",
        suggestionError: "The suggestion Agent is rate limited",
      }),
    });
    expect(
      screen.getByText(/Couldn’t suggest again — The suggestion Agent is rate limited/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  test.each([
    ["a suggestion", item()],
    ["a running suggestion", item({ proposal: null, suggestionState: "pending" })],
    ["a failed suggestion", item({ proposal: null, suggestionState: "failed" })],
    ["no suggestion", item({ proposal: null })],
  ])("the message menu stays reachable in the strip for %s", (_state, message) => {
    renderTriage({
      item: message,
      menu: () => <button type="button" aria-label="Message actions" />,
    });
    expect(screen.getByRole("button", { name: "Message actions" })).toBeTruthy();
  });

  test("the message menu shows the kind and corrects it", async () => {
    const onSetKind = vi.fn();
    render(
      <InboxMessageMenu
        item={item({ kind: null })}
        rowOffers={NO_ROW_OFFERS}
        handlers={{
          onOpenPage: vi.fn(),
          onDispatch: vi.fn(),
          onSuggestAgain: vi.fn(),
          onSetDone: vi.fn(),
          onSetKind,
          onSetImportant: vi.fn(),
          onDelete: vi.fn(),
        }}
      />,
    );
    await openNodexMenu(screen.getByRole("button", { name: "Message actions" }));
    // Until the user sets one, the kind is the one the suggestion proposes.
    const kind = await screen.findByRole("menuitem", { name: /Kind/ });
    expect(kind.textContent).toContain("Question");
    await act(async () => {
      fireEvent.click(kind);
      await Promise.resolve();
    });
    const todo = await screen.findByRole("menuitem", { name: "Todo" });
    await act(async () => {
      fireEvent.click(todo);
      await Promise.resolve();
    });
    expect(onSetKind).toHaveBeenCalledWith("todo");
  });
});

const menuHandlers = (overrides: Partial<InboxMessageMenuHandlers> = {}) => ({
  onOpenPage: vi.fn(),
  onDispatch: vi.fn(),
  onSuggestAgain: vi.fn(),
  onSetDone: vi.fn(),
  onSetKind: vi.fn(),
  onSetImportant: vi.fn(),
  onDelete: vi.fn(),
  ...overrides,
});

const menuItems = () =>
  screen.getAllByRole("menuitem").map((entry) => entry.textContent?.trim() ?? "");

describe("The message menu", () => {
  const triageWithMenu = (message: InboxItem) =>
    renderTriage({
      item: message,
      menu: (rowOffers) => (
        <InboxMessageMenu item={message} rowOffers={rowOffers} handlers={menuHandlers()} />
      ),
    });

  test("leaves out what the row already offers", async () => {
    triageWithMenu(item({ proposal: null, suggestionState: "settled" }));
    expect(screen.getByRole("button", { name: "Mark done" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Handle manually" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Suggest" })).toBeTruthy();
    await openNodexMenu(screen.getByRole("button", { name: "Message actions" }));
    await screen.findByRole("menuitem", { name: "Open page" });
    const entries = menuItems();
    expect(entries).not.toContain("Mark done");
    expect(entries).not.toContain("Handle manually");
    expect(entries).not.toContain("Suggest again");
  });

  test("keeps Handle manually beside a suggestion, where it changes the suggestion", async () => {
    triageWithMenu(item());
    expect(screen.queryByRole("button", { name: "Handle manually" })).toBeNull();
    await openNodexMenu(screen.getByRole("button", { name: "Message actions" }));
    await screen.findByRole("menuitem", { name: "Handle manually" });
    expect(menuItems()).not.toContain("Mark done");
    expect(menuItems()).toContain("Suggest again");
  });
});

describe("Importance", () => {
  const message = (
    important: boolean,
    handlers: { onUnmarkImportant?: () => void; onOpenPage?: () => void } = {},
  ) => (
    <TestQueryProvider>
      <InboxMessage
        item={item({ important })}
        selected={false}
        selectionActive={false}
        onToggleSelected={vi.fn()}
        linkedChats={null}
        onOpenChat={vi.fn()}
        onOpenPage={handlers.onOpenPage ?? vi.fn()}
        onUnmarkImportant={handlers.onUnmarkImportant ?? vi.fn()}
        editor={null}
        messageActions={null}
        strip={null}
        actions={<span>Row</span>}
      />
    </TestQueryProvider>
  );
  const chooseFromMenu = async (important: boolean, name: string) => {
    const onSetImportant = vi.fn();
    render(
      <InboxMessageMenu
        item={item({ important })}
        rowOffers={NO_ROW_OFFERS}
        handlers={menuHandlers({ onSetImportant })}
      />,
    );
    await openNodexMenu(screen.getByRole("button", { name: "Message actions" }));
    const action = await screen.findByRole("menuitem", { name });
    await act(async () => {
      fireEvent.click(action);
      await Promise.resolve();
    });
    return onSetImportant;
  };

  test("a waiting message is marked important from its menu", async () => {
    expect(await chooseFromMenu(false, "Mark important")).toHaveBeenCalledExactlyOnceWith(true);
  });

  test("the same menu takes the mark off", async () => {
    expect(await chooseFromMenu(true, "Unmark important")).toHaveBeenCalledExactlyOnceWith(false);
  });

  test("only an important message has a star, and the star takes the mark off", async () => {
    const onUnmarkImportant = vi.fn();
    const view = render(message(true, { onUnmarkImportant }));
    await click("Unmark important");
    expect(onUnmarkImportant).toHaveBeenCalledOnce();

    view.rerender(message(false, { onUnmarkImportant }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Unmark important" })).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "Mark important" })).toBeNull();
  });

  test("a message's time opens its Page", async () => {
    const onOpenPage = vi.fn();
    render(message(false, { onOpenPage }));
    await click("Open page");
    expect(onOpenPage).toHaveBeenCalledOnce();
  });
});

const historyChat = (overrides: Partial<InboxChat> = {}): InboxChat => ({
  sessionId: "session:1",
  projectId: "project:nodex",
  projectName: "Nodex",
  displayTitle: "Homepage positioning",
  threadId: "thread:1",
  executionRef: null,
  status: { statusType: "idle", activeFlags: [] },
  unread: false,
  archived: false,
  ...overrides,
});

const delivered = (pageId: string, title: string, chat: InboxChat, done = false) =>
  item({
    pageId,
    title,
    state: done ? "done" : "open",
    outcome: "chat",
    proposal: proposal({ state: "completed", chat }),
  });

const historyHandlers = () => ({
  onOpenTarget: vi.fn(),
  onOpenPage: vi.fn(),
  onReturn: vi.fn(),
  onSetDone: vi.fn(),
  onDelete: vi.fn(),
});

const rowIds = (container: HTMLElement = document.body) =>
  within(container)
    .getAllByTestId("inbox-history-row")
    .map((row) => row.getAttribute("data-inbox-page-id"));

const historyRow = (pageId: string) =>
  screen
    .getAllByTestId("inbox-history-row")
    .find((row) => row.getAttribute("data-inbox-page-id") === pageId)!;

describe("InboxHistory", () => {
  test("a delivered chat shows its live status and opens the conversation", async () => {
    const handlers = historyHandlers();
    render(
      <TestQueryProvider>
        <InboxHistory
          items={[
            delivered(
              "page:1",
              "Homepage positioning",
              historyChat({ status: { statusType: "active", activeFlags: ["waitingOnApproval"] } }),
            ),
          ]}
          {...handlers}
        />
      </TestQueryProvider>,
    );
    expect(screen.getByText("Started “Homepage positioning”")).toBeTruthy();
    expect(screen.getByText("Waiting")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { expanded: false }));
      await Promise.resolve();
    });
    await click("Open chat");
    expect(handlers.onOpenTarget).toHaveBeenCalledWith({ kind: "session", sessionId: "session:1" });
  });

  test("work still under way leads, and the user closes a finished chat's work", async () => {
    const handlers = historyHandlers();
    render(
      <TestQueryProvider>
        <InboxHistory
          items={[
            delivered(
              "page:working",
              "Fix the Board header",
              historyChat({ status: { statusType: "active", activeFlags: [] } }),
            ),
            delivered("page:read", "Rename the tab", historyChat()),
            delivered("page:reply", "Audit empty states", historyChat({ unread: true })),
            delivered("page:closed", "Ship the digest", historyChat({ unread: true }), true),
            item({ pageId: "page:kept", title: "A note", state: "kept", outcome: "kept" }),
          ]}
          {...handlers}
        />
      </TestQueryProvider>,
    );
    // A chat that is working or has a reply the user has not read is still in progress; one
    // that went quiet after they read it, or whose work they closed, is finished.
    const inProgress = rowIds(screen.getByRole("region", { name: "In progress" }));
    expect(inProgress).toEqual(["page:working", "page:reply"]);
    expect(rowIds().filter((id) => !inProgress.includes(id))).toEqual([
      "page:read",
      "page:closed",
      "page:kept",
    ]);
    expect(within(historyRow("page:reply")).getByText("New reply")).toBeTruthy();

    const reply = historyRow("page:reply");
    await act(async () => {
      fireEvent.click(within(reply).getByRole("button", { expanded: false }));
      await Promise.resolve();
    });
    // Dispatched work cannot return to the Inbox; it can only be closed.
    expect(within(reply).queryByRole("button", { name: "Return to Inbox" })).toBeNull();
    await act(async () => {
      fireEvent.click(within(reply).getByRole("button", { name: "Mark done" }));
      await Promise.resolve();
    });
    expect(handlers.onSetDone).toHaveBeenCalledWith("page:reply", true);

    const closed = historyRow("page:closed");
    expect(within(closed).getByText("Done")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(closed).getByRole("button", { expanded: false }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(within(closed).getByRole("button", { name: "Reopen" }));
      await Promise.resolve();
    });
    expect(handlers.onSetDone).toHaveBeenCalledWith("page:closed", false);
  });

  test("a kept message can return to the Inbox or be deleted", async () => {
    const handlers = historyHandlers();
    const kept = item({
      state: "kept",
      outcome: "kept",
      proposal: proposal({ state: "dismissed" }),
    });
    render(
      <TestQueryProvider>
        <InboxHistory items={[kept]} {...handlers} />
      </TestQueryProvider>,
    );
    expect(screen.queryByRole("region", { name: "In progress" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { expanded: false }));
      await Promise.resolve();
    });
    expect(screen.getByText("Homepage feels like a dev tool")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
    await click("Return to Inbox");
    expect(handlers.onReturn).toHaveBeenCalledWith("page:1");
    await click("Delete");
    expect(handlers.onDelete).toHaveBeenCalledWith(kept);
  });
});

describe("InboxDeleteDialog", () => {
  test("shows what will be erased and erases only on confirm", async () => {
    const onConfirm = vi.fn(async () => undefined);
    const onCancel = vi.fn();
    render(
      <InboxDeleteDialog
        request={{ pageIds: ["page:1"], preview: "Use the key sk-live-0123456789" }}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    expect(await screen.findByText("Delete this message?")).toBeTruthy();
    expect(screen.getByText("Use the key sk-live-0123456789")).toBeTruthy();
    expect(screen.getByText(/rotate it/)).toBeTruthy();
    await click("Cancel");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    await click("Delete");
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });
});

describe("InboxMessage source navigation", () => {
  test.each(["run:child", null])(
    "opens the owning product Session for a child source with Run %s",
    async (runId) => {
      const onOpenChat = vi.fn();
      render(
        <TestQueryProvider>
          <InboxMessage
            item={item({
              source: {
                kind: "agent",
                sessionId: "session:owner",
                threadId: "thread:child",
                runId,
                projectId: "project:another",
                label: "Research Agent",
              },
            })}
            selected={false}
            selectionActive={false}
            onToggleSelected={vi.fn()}
            linkedChats={null}
            onOpenChat={onOpenChat}
            onOpenPage={vi.fn()}
            onUnmarkImportant={vi.fn()}
            editor={null}
            messageActions={null}
            strip={null}
            actions={null}
          />
        </TestQueryProvider>,
      );
      await click("From Research Agent");
      expect(onOpenChat).toHaveBeenCalledExactlyOnceWith("session:owner");
    },
  );

  test("an unavailable Session cannot be replaced with a native Thread lookup", async () => {
    const onOpenChat = vi.fn();
    render(
      <TestQueryProvider>
        <InboxMessage
          item={item({
            source: {
              kind: "agent",
              sessionId: null,
              threadId: "thread:child",
              runId: null,
              projectId: "project:another",
              label: "Research Agent",
            },
          })}
          selected={false}
          selectionActive={false}
          onToggleSelected={vi.fn()}
          linkedChats={null}
          onOpenChat={onOpenChat}
          onOpenPage={vi.fn()}
          onUnmarkImportant={vi.fn()}
          editor={null}
          messageActions={null}
          strip={null}
          actions={null}
        />
      </TestQueryProvider>,
    );
    expect(
      screen.getByRole("button", { name: "From Research Agent" }).hasAttribute("disabled"),
    ).toBe(true);
    await click("From Research Agent");
    expect(onOpenChat).not.toHaveBeenCalled();
  });
});
