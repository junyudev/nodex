import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { openNodexMenu, render } from "@/test/dom";
import type { InboxItem, InboxProposal } from "../../../shared/inbox";
import type { Project } from "../../../shared/types";
import { InboxDeleteDialog } from "./inbox-delete-dialog";
import { draftForInboxItem } from "./inbox-dispatch-editor";
import { InboxHistory } from "./inbox-history";
import { InboxMessage } from "./inbox-message";
import { InboxTriage } from "./inbox-triage";
import type { InboxActions } from "./use-inbox-actions";

const project = (id: string, name: string): Project =>
  ({ id, name, lifecycle: "active", databaseId: `db:${id}` }) as Project;

const proposal = (overrides: Partial<InboxProposal> = {}): InboxProposal => ({
  proposalId: "proposal:1",
  revision: 2,
  origin: "agent",
  state: "open",
  pageIds: ["page:1"],
  basis: [{ pageId: "page:1", generation: 1, headSeq: 1, placementRevision: 1 }],
  action: { type: "new_chat", projectId: "project:nodex", prompt: "Compare both positions." },
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
  basis: { pageId: "page:1", generation: 1, headSeq: 1, placementRevision: 1 },
  pageKey: "IN-1",
  title: "Homepage positioning",
  body: "Homepage feels like a dev tool",
  bodyTruncated: false,
  bodyEditable: true,
  submittedAt: "2026-10-11T10:00:00.000Z",
  source: { kind: "user" },
  kind: "question",
  state: "open",
  suggestionState: "settled",
  suggestionError: null,
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
  requestSuggestion: vi.fn(async () => true),
  retryDispatch: vi.fn(async () => true),
});

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
        suggestionsEnabled
        actions={commands}
        manualDraft={null}
        groupedWithKey={null}
        inboxProjectId={null}
        menu={null}
        onManualDraftChange={vi.fn()}
        onEditAsPage={vi.fn()}
        {...overrides}
      >
        {({ editor, strip, actions: row }) => (
          <>
            {editor ?? <p>{overrides.item?.body ?? item().body}</p>}
            {strip}
            {row}
          </>
        )}
      </InboxTriage>
    </QueryClientProvider>,
  );
  return commands;
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
        basis: [
          item().basis,
          { pageId: "page:2", generation: 2, headSeq: 3, placementRevision: 4 },
        ],
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
          suggestionsEnabled
          awaitingIndicator
          actions={actions()}
          manualDraft={null}
          groupedWithKey={null}
          inboxProjectId={null}
          menu={null}
          onManualDraftChange={onManualDraftChange}
          onEditAsPage={vi.fn()}
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
        inboxProjectId={null}
        suggestionsEnabled
        actions={commands}
        manualDraft={null}
        groupedWithKey={null}
        menu={null}
        onManualDraftChange={vi.fn()}
        onEditAsPage={vi.fn()}
      >
        {({ editor, strip, actions: controls }) => (
          <>
            {editor ?? message.body}
            {strip}
            {controls}
          </>
        )}
      </InboxTriage>
    );
    const rendered = render(view(item({ body: "A" })));
    await click("Edit");
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: "Edit message" }), {
        target: { value: "B" },
      });
    });
    rendered.rerender(
      view(
        item({
          body: "C",
          basis: { pageId: "page:1", generation: 1, headSeq: 2, placementRevision: 1 },
        }),
      ),
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

  test("refines only the frozen proposal without capturing another message", async () => {
    const commands = renderTriage();
    await click("Refine suggestion");
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: "Refine suggestion" }), {
        target: { value: "Keep this for later" },
      });
    });
    await click("Update suggestion");
    await waitFor(() =>
      expect(commands.requestSuggestion).toHaveBeenCalledWith(
        proposal().pageIds,
        proposal().basis,
        { proposal: proposal(), correction: "Keep this for later" },
      ),
    );
    expect(commands.send).not.toHaveBeenCalled();
    expect(commands.confirm).not.toHaveBeenCalled();
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
        { pageId: "page:1", label: "IN-1", body: "First" },
        { pageId: "page:2", label: "IN-2", body: "Second" },
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
    expect(screen.getByText("Compare both homepage positions first.")).toBeTruthy();
    // The exact destination is visible before confirming.
    expect(screen.getByRole("button", { name: "Kind: Question" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New chat in Nodex" })).toBeTruthy();
    await click("New chat in Nodex");
    await waitFor(() => expect(commands.confirm).toHaveBeenCalledWith(proposal()));
    expect(commands.dispatch).not.toHaveBeenCalled();
  });

  test("Edit rewrites the message itself and asks nothing to run", async () => {
    const commands = renderTriage();
    await click("Edit");
    const editor = await screen.findByRole("textbox", { name: "Edit message" });
    expect((editor as HTMLTextAreaElement).value).toBe("Homepage feels like a dev tool");
    // What Nodex made of the old text steps aside while it is rewritten.
    expect(screen.queryByText("Compare both homepage positions first.")).toBeNull();
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
        { pageId: "page:1", generation: 1, headSeq: 1, placementRevision: 1 },
      ),
    );
    expect(await screen.findByText("Compare both homepage positions first.")).toBeTruthy();
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

  test("a message too rich to rewrite in place is edited as its Page", async () => {
    const onEditAsPage = vi.fn();
    renderTriage({ item: item({ bodyEditable: false }), onEditAsPage });
    await click("Edit as Page");
    expect(onEditAsPage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox", { name: "Edit message" })).toBeNull();
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
      expect(commands.confirm).toHaveBeenCalledWith(grouped, {
        type: "new_chat",
        projectId: "project:nodex",
        prompt: "Only list the trade-offs.",
      }),
    );
  });

  test("keep and done clear the message without dispatching it", async () => {
    const commands = renderTriage();
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
    await click("Retry");
    await waitFor(() =>
      expect(commands.requestSuggestion).toHaveBeenCalledWith(["page:1"], [item().basis]),
    );
    await click("Handle manually");
    expect(onManualDraftChange).toHaveBeenCalledWith(
      expect.objectContaining({ type: "new_chat", prompt: "Homepage feels like a dev tool" }),
    );
  });

  test.each([
    ["a suggestion", item()],
    ["a running suggestion", item({ proposal: null, suggestionState: "pending" })],
    ["a failed suggestion", item({ proposal: null, suggestionState: "failed" })],
    ["no suggestion", item({ proposal: null })],
  ])("the message menu stays reachable in the strip for %s", (_state, message) => {
    renderTriage({
      item: message,
      menu: <button type="button" aria-label="Message actions" />,
    });
    expect(screen.getByRole("button", { name: "Message actions" })).toBeTruthy();
  });

  test("a message without a suggestion still shows and corrects its kind in the strip", async () => {
    const commands = renderTriage({ item: item({ kind: "todo", proposal: null }) });
    await openNodexMenu(screen.getByRole("button", { name: "Kind: Todo" }));
    const question = await screen.findByRole("menuitem", { name: "Question" });
    await act(async () => {
      fireEvent.click(question);
      await Promise.resolve();
    });
    await waitFor(() => expect(commands.setKind).toHaveBeenCalledWith("page:1", "question"));
  });
});

describe("InboxHistory", () => {
  test("a delivered chat shows its live status and opens the conversation", async () => {
    const onOpenTarget = vi.fn();
    render(
      <InboxHistory
        items={[
          item({
            outcome: "chat",
            proposal: proposal({
              state: "completed",
              chat: {
                sessionId: "session:1",
                projectId: "project:nodex",
                projectName: "Nodex",
                displayTitle: "Homepage positioning",
                threadId: "thread:1",
                status: { statusType: "active", activeFlags: ["waitingOnApproval"] },
                unread: false,
                archived: false,
              },
            }),
          }),
        ]}
        onOpenTarget={onOpenTarget}
        onOpenPage={vi.fn()}
        onReturn={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Started “Homepage positioning”")).toBeTruthy();
    expect(screen.getByText("Waiting")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { expanded: false }));
      await Promise.resolve();
    });
    await click("Open chat");
    expect(onOpenTarget).toHaveBeenCalledWith({ kind: "session", sessionId: "session:1" });
  });

  test("a kept message can return to the Inbox or be deleted", async () => {
    const onReturn = vi.fn();
    const onDelete = vi.fn();
    const kept = item({
      state: "kept",
      outcome: "kept",
      proposal: proposal({ state: "dismissed" }),
    });
    render(
      <InboxHistory
        items={[kept]}
        onOpenTarget={vi.fn()}
        onOpenPage={vi.fn()}
        onReturn={onReturn}
        onDelete={onDelete}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { expanded: false }));
      await Promise.resolve();
    });
    expect(screen.getByText("Homepage feels like a dev tool")).toBeTruthy();
    await click("Return to Inbox");
    expect(onReturn).toHaveBeenCalledWith("page:1");
    await click("Delete");
    expect(onDelete).toHaveBeenCalledWith(kept);
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
      const onOpenSource = vi.fn();
      render(
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
          onOpenSource={onOpenSource}
          editor={null}
          strip={null}
          actions={null}
        />,
      );
      await click("From Research Agent");
      expect(onOpenSource).toHaveBeenCalledExactlyOnceWith("session:owner");
    },
  );

  test("an unavailable Session cannot be replaced with a native Thread lookup", async () => {
    const onOpenSource = vi.fn();
    render(
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
        onOpenSource={onOpenSource}
        editor={null}
        strip={null}
        actions={null}
      />,
    );
    expect(
      screen.getByRole("button", { name: "From Research Agent" }).hasAttribute("disabled"),
    ).toBe(true);
    await click("From Research Agent");
    expect(onOpenSource).not.toHaveBeenCalled();
  });
});
