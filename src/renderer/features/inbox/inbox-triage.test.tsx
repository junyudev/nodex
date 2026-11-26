import * as rendererSpace from "@/lib/renderer-space";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { renderWithAppMaitai } from "@/test/app-maitai";
import { TestQueryProvider } from "@/test/query";
import type { InboxItem, InboxProposal } from "../../../shared/inbox";
import type { Project } from "../../../shared/types";
import { draftForInboxItem } from "./inbox-dispatch-editor";
import { InboxMessage } from "./inbox-message";
import { InboxTriage } from "./inbox-triage";
import type { InboxActions } from "./use-inbox-actions";
import { inboxAgentsFixture } from "./inbox-agents.test-support";

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
  explicitRequest: false,
  confirmedBy: null,
  action: {
    type: "new_chat",
    additions: [],
    projectId: "project:nodex",
    prompt: "Compare both positions.",
    agent: null,
  },
  kind: "question",
  summary: "Compare both homepage positions first.",
  rationale: "Still an open question.",
  producedBy: "Codex",
  targetProjectName: "Nodex",
  chat: null,
  failureMessage: null,
  failureKind: null,
  decisionSessionId: null,
  createdAt: "2026-10-11T10:00:00.000Z",
  updatedAt: "2026-10-11T10:00:00.000Z",
  ...overrides,
});

const item = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  pageId: "page:1",
  rowKind: "intake",
  snooze: null,
  turn: null,
  basis: { pageId: "page:1", contentHash: "content:1" },
  pageKey: "IN-1",
  pageStatus: null,
  title: "Homepage positioning",
  body: "Homepage feels like a dev tool",
  bodyTruncated: false,
  bodyEditable: true,
  submittedAt: "2026-10-11T10:00:00.000Z",
  source: { kind: "user" },
  replyToPageId: null,
  kind: "question",
  important: false,
  waiting: true,
  suggestionState: "settled",
  suggestionError: null,
  automationDecision: null,
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
  saveToNotes: vi.fn(async () => true),
  wake: vi.fn(async () => true),
  snooze: vi.fn(async () => true),
  delete: vi.fn(async () => true),
  setState: vi.fn(async () => true),
  setKind: vi.fn(async () => true),
  setImportant: vi.fn(async () => true),
  requestSuggestion: vi.fn(async () => true),
  stopSuggestion: vi.fn(async () => true),
  retryDispatch: vi.fn(async () => true),
});

/** Whether the last rendered row already opens the message's chat. */
let rowOpensChat = false;

const renderTriage = (
  overrides: Partial<Parameters<typeof InboxTriage>[0]> = {},
  commands: InboxActions = actions(),
) => {
  renderWithAppMaitai(
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
    const rendered = renderWithAppMaitai(
      <TestQueryProvider>{view(item({ body: "A" }))}</TestQueryProvider>,
    );
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

  test("team Automation execution stays disabled while the person can skip the held decision", async () => {
    const remote = vi.spyOn(rendererSpace, "isRemoteSpace").mockReturnValue(true);
    try {
      const commands = renderTriage({
        item: item({
          proposal: proposal({
            origin: "automation",
            action: { type: "execute_decision", decisionId: "dispatch:team", agent: null },
          }),
          automationDecision: {
            automationId: "same-automation",
            dispatchId: "dispatch:team",
            status: "held",
            firstScheduledFor: 1,
            lastScheduledFor: 1,
            missedCount: 0,
            failureMessage: null,
          },
        }),
      });
      const run = screen.getByRole("button", { name: /^Run/ });
      expect((run as HTMLButtonElement).disabled).toBe(true);
      await act(async () => {
        fireEvent.click(run);
        await Promise.resolve();
      });
      expect(commands.confirm).not.toHaveBeenCalled();
      await click("Skip this run");
      await waitFor(() => expect(commands.setState).toHaveBeenCalledWith(["page:1"], "done"));
    } finally {
      remote.mockRestore();
    }
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

  test("a suggestion's additions are sent unless unchecked, and Handle manually writes the kept ones into its prompt", async () => {
    const offered = proposal({
      action: {
        type: "new_chat",
        projectId: "project:nodex",
        prompt: "Fix the scroll jump.",
        agent: null,
        additions: ["Hand the measurement work to GPT-6.1 Sol.", "Start from thread-body.tsx."],
      },
    });
    const commands = renderTriage({ item: item({ proposal: offered }) });
    const handOff = screen.getByRole("checkbox", {
      name: "Hand the measurement work to GPT-6.1 Sol.",
    });
    expect(handOff.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(handOff);
      await Promise.resolve();
    });
    expect(handOff.getAttribute("aria-checked")).toBe("false");
    await click("New chat in Nodex");
    const kept = { ...offered.action, additions: ["Start from thread-body.tsx."] };
    await waitFor(() => expect(commands.confirm).toHaveBeenCalledWith(offered, kept));
    expect(draftForInboxItem(item({ proposal: offered }), null, kept).prompt).toBe(
      "Fix the scroll jump.\n\nStart from thread-body.tsx.",
    );
  });

  test("a new chat's place to work is switched beside its model, shown on the decision, and sent", async () => {
    const agents = inboxAgentsFixture();
    const commands = renderTriage({ agents });
    const menuHalf = () => screen.getByRole("button", { name: "Choose how this chat starts" });
    // Following the Inbox's own choice, the decision says nothing about where the chat works.
    expect(menuHalf().textContent).toBe("");
    await click("Choose how this chat starts");
    const worktree = await screen.findByRole("switch", { name: "Use a worktree" });
    expect(worktree.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(worktree);
      await Promise.resolve();
    });
    // The menu stays open, and the choice that now differs from the Inbox's shows on the decision.
    expect(
      screen.getByRole("switch", { name: "Use a worktree" }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(menuHalf().textContent).toBe("Local");
    await click("Set as Inbox default");
    await waitFor(() =>
      expect(agents.save).toHaveBeenCalledWith({
        chatAgent: agents.settings.chatAgent,
        newChatsUseWorktrees: false,
      }),
    );
    await click("New chat in Nodex");
    await waitFor(() =>
      expect(commands.confirm).toHaveBeenCalledWith(proposal(), {
        ...proposal().action,
        worktree: false,
      }),
    );
  });

  test("a projectless chat has no place to choose", async () => {
    renderTriage({
      item: item({
        proposal: proposal({
          action: {
            type: "new_chat",
            additions: [],
            projectId: null,
            prompt: "Plan it.",
            agent: null,
          },
          targetProjectName: null,
        }),
      }),
    });
    await click("Choose how this chat starts");
    await screen.findByRole("slider", { name: "Effort" });
    expect(screen.queryByRole("switch", { name: "Use a worktree" })).toBeNull();
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

  test("new advice for an outdated suggestion runs beside it, then reports a failure there", () => {
    const outdated = proposal({ outdated: true });
    const { unmount } = renderWithAppMaitai(
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
});

describe("Snooze", () => {
  test("a suggested time that has passed asks for another instead of confirming", () => {
    const later = proposal({
      action: { type: "snooze", snoozedUntil: "2020-01-01T09:00:00.000Z" },
      summary: "This can wait.",
    });
    renderTriage({ item: item({ proposal: later }) });
    expect(screen.getByRole("button", { name: /^Snooze · / })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Choose another time" })).toBeTruthy();
  });
});

describe("InboxMessage source navigation", () => {
  test.each(["run:child", null])(
    "opens the owning product Session for a child source with Run %s",
    async (runId) => {
      const onOpenChat = vi.fn();
      renderWithAppMaitai(
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
    renderWithAppMaitai(
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

test("a handed-back intake keeps the original words and opens its previous chat", async () => {
  const onOpenChat = vi.fn();
  renderWithAppMaitai(
    <TestQueryProvider>
      <InboxMessage
        item={item({
          body: "Please fix only the README typo.",
          handback: {
            receipt_id: "receipt",
            reason: "This belongs to the documentation chat.",
            returned_at: "2026-11-05T00:00:00.000Z",
            chat: {
              session_id: "previous",
              display_title: "Search indexing",
              project_id: null,
              project_name: null,
              thread_id: null,
              status: null,
              unread: false,
              archived: false,
            },
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
  expect(screen.getByText("Please fix only the README typo.")).toBeTruthy();
  expect(screen.getByText(/sent this back:/u)).toBeTruthy();
  expect(screen.getByText(/This belongs to the documentation chat\./u)).toBeTruthy();
  await click("Search indexing");
  expect(onOpenChat).toHaveBeenCalledExactlyOnceWith("previous");
});
