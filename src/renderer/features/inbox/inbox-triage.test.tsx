import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { openNodexMenu, render } from "@/test/dom";
import type { InboxItem, InboxProposal } from "../../../shared/inbox";
import type { Project } from "../../../shared/types";
import { InboxDeleteDialog } from "./inbox-delete-dialog";
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
  action: { type: "new_chat", projectId: "project:nodex", prompt: "Compare both positions." },
  kind: "question",
  summary: "Compare both homepage positions first.",
  rationale: "Still an open question.",
  producedBy: "Codex",
  targetProjectName: "Nodex",
  chat: null,
  failureMessage: null,
  createdAt: "2026-10-11T10:00:00.000Z",
  updatedAt: "2026-10-11T10:00:00.000Z",
  ...overrides,
});

const item = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  pageId: "page:1",
  pageKey: "IN-1",
  title: "Homepage positioning",
  body: "Homepage feels like a dev tool",
  bodyTruncated: false,
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
  send: vi.fn(async () => true),
  confirm: vi.fn(async () => true),
  dispatch: vi.fn(async () => true),
  keep: vi.fn(async () => true),
  delete: vi.fn(async () => true),
  setState: vi.fn(async () => true),
  setKind: vi.fn(async () => true),
  requestSuggestion: vi.fn(async () => true),
  retryDispatch: vi.fn(async () => true),
});

const renderTriage = (overrides: Partial<Parameters<typeof InboxTriage>[0]> = {}) => {
  const commands = actions();
  render(
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
      {...overrides}
    >
      {({ strip, actions: row }) => (
        <>
          {strip}
          {row}
        </>
      )}
    </InboxTriage>,
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
  test("confirms the exact suggested action and nothing else", async () => {
    const commands = renderTriage();
    expect(screen.getByText("Compare both homepage positions first.")).toBeTruthy();
    // The kind leads the suggestion as a glyph; the destination waits in the button's tooltip.
    expect(screen.getByRole("button", { name: "Kind: Question" })).toBeTruthy();
    expect(screen.queryByText(/New chat in Nodex/)).toBeNull();
    await click("Start chat");
    await waitFor(() => expect(commands.confirm).toHaveBeenCalledWith(proposal()));
    expect(commands.dispatch).not.toHaveBeenCalled();
  });

  test("an edited suggestion confirms the edited action against the same proposal", async () => {
    const commands = renderTriage();
    await click("Edit");
    const prompt = await screen.findByRole("textbox", { name: "Prompt" });
    await act(async () => {
      fireEvent.change(prompt, { target: { value: "Only list the trade-offs." } });
      await Promise.resolve();
    });
    await click("Start chat");
    await waitFor(() =>
      expect(commands.confirm).toHaveBeenCalledWith(proposal(), {
        type: "new_chat",
        projectId: "project:nodex",
        prompt: "Only list the trade-offs.",
      }),
    );
  });

  test("keep and done clear the message without dispatching it", async () => {
    const commands = renderTriage();
    await click("Keep as a note");
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
    await waitFor(() => expect(commands.requestSuggestion).toHaveBeenCalledWith(["page:1"]));
    await click("Dispatch…");
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
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitem", { name: "Question" }));
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
    const kept = item({ state: "kept", proposal: proposal({ state: "dismissed" }) });
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
    await click("Delete…");
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
