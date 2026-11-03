import { act, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { CodexSidebarThreadItem } from "@/lib/types";
import { render } from "@/test/dom";
import { click, deferred } from "./agent-instance-settings.test-fixtures";
import { ProjectArchiveChatsDialog } from "./project-archive-chats-dialog";

const toast = vi.hoisted(() => ({ success: vi.fn(), danger: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ toast }));
beforeEach(() => vi.clearAllMocks());

const chat = (threadId: string): CodexSidebarThreadItem => ({
  key: threadId,
  kind: "local",
  backendBinding: { kind: "codex" },
  runLocation: { kind: "local-checkout" },
  hostId: "local",
  threadId,
  parentThreadId: null,
  sessionId: null,
  projectId: "project-a",
  title: threadId,
  preview: "",
  cwd: "/repo",
  updatedAt: 2,
  createdAt: 1,
  pinned: false,
  pinnedOrder: null,
  unread: false,
  remindAt: null,
  archived: false,
  statusType: "idle",
  statusActiveFlags: [],
  projectless: false,
  disabled: false,
});

test("keeps archiving locked until the refreshed chats arrive, then releases the dialog", async () => {
  const refreshed = deferred<void>();
  const onArchiveItem = vi.fn(async () => true);
  const onArchived = vi.fn(() => refreshed.promise);
  const onOpenChange = vi.fn();
  const view = render(
    <ProjectArchiveChatsDialog
      open
      projectName="Nodex"
      items={[chat("one"), chat("two")]}
      onArchiveItem={onArchiveItem}
      onArchived={onArchived}
      onOpenChange={onOpenChange}
    />,
  );
  await click(await view.findByRole("button", { name: "Archive all" }));
  await waitFor(() => expect(onArchived).toHaveBeenCalledOnce());
  expect(onArchiveItem).toHaveBeenCalledTimes(2);
  expect(view.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
  expect(view.getByRole("button", { name: "Archiving…" })).toHaveProperty("disabled", true);
  expect(onOpenChange).not.toHaveBeenCalled();
  await act(async () => {
    refreshed.resolve();
    await refreshed.promise;
  });
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Archive all" })).toHaveProperty("disabled", false),
  );
  expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  expect(toast.success).toHaveBeenCalledExactlyOnceWith("Archived 2 chats");
});

test("counts a rejected archive as a failed chat and releases the controls after the batch", async () => {
  const onArchiveItem = vi.fn(async (item: CodexSidebarThreadItem) => {
    if (item.threadId === "two") throw new Error("Archive unavailable");
    return true;
  });
  const onOpenChange = vi.fn();
  const onArchived = vi.fn();
  const view = render(
    <ProjectArchiveChatsDialog
      open
      projectName="Nodex"
      items={[chat("one"), chat("two")]}
      onArchiveItem={onArchiveItem}
      onArchived={onArchived}
      onOpenChange={onOpenChange}
    />,
  );
  await click(await view.findByRole("button", { name: "Archive all" }));
  await waitFor(() =>
    expect(toast.danger).toHaveBeenCalledWith("Archived 1 chat in Nodex; 1 failed"),
  );
  expect(onArchived).toHaveBeenCalledOnce();
  expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  expect(view.getByRole("button", { name: "Archive all" })).toHaveProperty("disabled", false);
});
