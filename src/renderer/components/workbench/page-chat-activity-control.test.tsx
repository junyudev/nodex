import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { render } from "@/test/dom";
import type { PageChatActivitySummary, PageChatItem } from "@/lib/types";
import { PageChatActivityControl } from "./page-chat-activity-control";

const summary = (overrides: Partial<PageChatActivitySummary> = {}): PageChatActivitySummary => ({
  pageId: "page-1",
  relatedCount: 1,
  workingCount: 0,
  waitingOnApprovalCount: 0,
  waitingOnUserInputCount: 0,
  errorCount: 0,
  unreadCount: 0,
  soleSessionId: "session-1",
  runtimeSessionIds: [],
  ...overrides,
});

const item = (overrides: Partial<PageChatItem> = {}): PageChatItem => ({
  sessionId: "session-1",
  projectId: "project-1",
  projectName: "Nodex",
  displayTitle: "Implement activity",
  threadId: "thread-1",
  executionRef: null,
  threadPreview: "Working through the renderer projection",
  threadStatus: { statusType: "idle", activeFlags: [] },
  threadArchived: false,
  unread: false,
  sessionArchived: false,
  conversationRecencyAt: 1,
  linkedAt: "2026-08-24T00:00:00Z",
  ...overrides,
});

function renderControl({
  activity = summary(),
  items = [item()],
  onOpenChat = vi.fn(async () => undefined),
  onRemoveRelation,
}: {
  readonly activity?: PageChatActivitySummary;
  readonly items?: readonly PageChatItem[];
  readonly onOpenChat?: (sessionId: string) => Promise<void> | void;
  readonly onRemoveRelation?: (sessionId: string) => Promise<void> | void;
} = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const parentClick = vi.fn();
  const parentPointerDown = vi.fn();
  const screen = render(
    <QueryClientProvider client={queryClient}>
      <div onClick={parentClick} onPointerDown={parentPointerDown}>
        <PageChatActivityControl
          pageId="page-1"
          summary={activity}
          onOpenChat={onOpenChat}
          onRemoveRelation={onRemoveRelation}
          detailOverride={{ items }}
        />
      </div>
    </QueryClientProvider>,
  );
  return { screen, parentClick, parentPointerDown, onOpenChat };
}

describe("PageChatActivityControl", () => {
  beforeEach(() => vi.clearAllMocks());

  test("renders working and unread as simultaneous signals", () => {
    const { screen } = renderControl({
      activity: summary({ workingCount: 1, unreadCount: 1 }),
    });
    const control = screen.getByRole("button", {
      name: "1 linked chat, 1 working chat, 1 unread chat",
    });
    expect(control.querySelector("[data-page-chat-unread='true']")).not.toBeNull();
    expect(control.querySelector("[data-activity-spinner='true']")).not.toBeNull();
  });

  test("uses an attention glyph rather than a spinner while waiting", () => {
    const { screen } = renderControl({
      activity: summary({ workingCount: 1, waitingOnApprovalCount: 1 }),
    });
    const control = screen.getByRole("button", {
      name: "1 linked chat, 1 awaiting approval, 1 working chat",
    });
    expect(control.querySelector("[data-activity-spinner='true']")).toBeNull();
  });

  test("opens a sole linked chat directly without bubbling a Page gesture", async () => {
    const onOpenChat = vi.fn(async () => undefined);
    const { screen, parentClick, parentPointerDown } = renderControl({ onOpenChat });
    const control = screen.getByRole("button", { name: "1 linked chat" });
    await act(async () => {
      fireEvent.pointerDown(control);
      fireEvent.click(control);
      await Promise.resolve();
    });
    await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith("session-1"));
    expect(parentPointerDown).not.toHaveBeenCalled();
    expect(parentClick).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Linked chats" })).toBeNull();
  });

  test("opens a lazy picker for multiple chats and navigates only after selection", async () => {
    const onOpenChat = vi.fn(async () => undefined);
    const second = item({
      sessionId: "session-2",
      threadId: null,
      threadStatus: null,
      displayTitle: "Research notes",
      threadPreview: "",
    });
    const { screen } = renderControl({
      activity: summary({ relatedCount: 2, soleSessionId: null, unreadCount: 1 }),
      items: [item({ unread: true }), second],
      onOpenChat,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "2 linked chats, 1 unread chat" }));
      await Promise.resolve();
    });
    expect(await screen.findByText("Linked chats")).not.toBeNull();
    expect(onOpenChat).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "2 linked chats, 1 unread chat" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByText("Linked chats")).toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "2 linked chats, 1 unread chat" }));
      await Promise.resolve();
    });
    expect(await screen.findByText("Linked chats")).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Research notes/ }));
      await Promise.resolve();
    });
    await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith("session-2"));
  });

  test("removes only the selected relation after confirmation from the owner", async () => {
    let resolveRemove: (() => void) | null = null;
    const onRemoveRelation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRemove = resolve;
        }),
    );
    const { screen } = renderControl({
      activity: summary({ relatedCount: 2, soleSessionId: null }),
      items: [item(), item({ sessionId: "session-2", displayTitle: "Research notes" })],
      onRemoveRelation,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "2 linked chats" }));
      await Promise.resolve();
    });
    const remove = await screen.findByRole("button", {
      name: "Remove relation to Implement activity",
    });
    await act(async () => {
      fireEvent.click(remove);
      await Promise.resolve();
    });
    expect(onRemoveRelation).toHaveBeenCalledWith("session-1");
    expect(remove.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      resolveRemove?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(remove.hasAttribute("disabled")).toBe(false));
  });
});
