import { act, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { CodexSidebarSnapshot, CodexSidebarThreadItem, Project } from "../../../shared/types";
import { render } from "../../test/dom";
import {
  ArchivedChatsSettingsPage,
  projectArchivedChatGroups,
  selectArchivedRootChats,
} from "./archived-chats-settings-page";

const invoke = vi.fn();
const subscribeCodexEvents = vi.fn((_callback: unknown) => () => undefined);
const subscribeProjectSessionChanges = vi.fn((_callback: unknown) => () => undefined);
const workspaceSessionCommand = vi.fn();
const successToast = vi.fn();
const dangerToast = vi.fn();

vi.mock("@/components/ui/toast", () => ({
  toast: {
    success: (...args: unknown[]) => successToast(...args),
    danger: (...args: unknown[]) => dangerToast(...args),
  },
}));

vi.mock("@/lib/api", () => ({
  subscribeCodexEvents: (callback: unknown) => subscribeCodexEvents(callback),
  subscribeProjectSessionChanges: (callback: unknown) => subscribeProjectSessionChanges(callback),
}));

vi.mock("@/lib/workspace-catalog-commands", () => ({
  workspaceSessionCommands: {
    delete: (sessionId: string) => workspaceSessionCommand("delete", sessionId),
    unarchive: (sessionId: string) => workspaceSessionCommand("unarchive", sessionId),
  },
}));

vi.mock("@/lib/workbench-settings-runtime", () => ({
  readArchivedChats: (refresh: boolean) =>
    invoke("codex:sidebar:snapshot", { includeArchived: true, refresh }),
  unarchiveChat: (threadId: string) => invoke("codex:thread:unarchive", threadId),
  deleteArchivedChat: (threadId: string) => invoke("codex:thread:delete-archived", threadId),
}));

function chat(
  threadId: string,
  overrides: Partial<CodexSidebarThreadItem> = {},
): CodexSidebarThreadItem {
  return {
    key: threadId,
    kind: "local",
    backendBinding: { kind: "codex" },
    runLocation: { kind: "local-checkout" },
    hostId: "local",
    threadId,
    parentThreadId: null,
    sessionId: null,
    projectId: "project-a",
    title: `Chat ${threadId}`,
    preview: `Preview ${threadId}`,
    cwd: "/repo/nodex",
    updatedAt: 200,
    createdAt: 100,
    pinned: false,
    pinnedOrder: null,
    unread: false,
    archived: true,
    statusType: "idle",
    statusActiveFlags: [],
    projectless: false,
    disabled: false,
    ...overrides,
  };
}

function snapshot(items: CodexSidebarThreadItem[]): CodexSidebarSnapshot {
  return {
    items,
    pinnedThreadIds: [],
    projectAssignments: {},
    projectlessThreadIds: [],
    generatedAt: 300,
  };
}

const projects = [{ id: "project-a", name: "Nodex" }] as Project[];

function renderPage() {
  return render(
    <ArchivedChatsSettingsPage
      activeProjectId={null}
      browserAnchor={null}
      browserDetail={null}
      composerEnterBehavior="enter"
      isMacPlatform
      onComposerEnterBehaviorChange={() => undefined}
      onOpenBrowserDetail={() => undefined}
      onPathChange={() => undefined}
      onRequestProjectPickerOpen={() => undefined}
      onTaskShorthandPagePromotionEnabledChange={() => undefined}
      onThreadQueueFollowUpsEnabledChange={() => undefined}
      onWorktreeAutoBranchPrefixChange={() => undefined}
      onWorktreeStartModeChange={() => undefined}
      open
      path="/settings/data-controls"
      projects={projects}
      taskShorthandPagePromotionEnabled={false}
      threadQueueFollowUpsEnabled={false}
      worktreeAutoBranchPrefix="codex/"
      worktreeStartMode="autoBranch"
    />,
  );
}

describe("Archived chats settings", () => {
  beforeEach(() => {
    invoke.mockReset();
    subscribeCodexEvents.mockClear();
    subscribeProjectSessionChanges.mockClear();
    workspaceSessionCommand.mockReset();
    successToast.mockReset();
    dangerToast.mockReset();
  });

  test("keeps the archived surface root-only and deterministically groups matching chats", () => {
    const root = chat("root");
    const child = chat("child", { parentThreadId: "root", title: "Nested agent" });
    const active = chat("active", { archived: false });
    const roots = selectArchivedRootChats(snapshot([root, child, active]));
    const groups = projectArchivedChatGroups({
      chats: roots,
      grouping: "project",
      projectNames: new Map([["project-a", "Nodex"]]),
      query: "nodex",
      sort: "updated",
    });

    expect(roots.map((entry) => entry.threadId)).toEqual(["root"]);
    expect(groups).toEqual([{ id: "project-a", label: "Nodex", chats: [root] }]);
  });

  test("loads, filters, unarchives, and permanently deletes only after confirmation", async () => {
    const alpha = chat("alpha", { title: "Alpha task" });
    const beta = chat("beta", { title: "Beta task", updatedAt: 150 });
    invoke.mockImplementation(async (channel: string, threadId?: string) => {
      if (channel === "codex:sidebar:snapshot") return snapshot([alpha, beta]);
      if (channel === "codex:thread:unarchive" && threadId === "alpha") return { id: "alpha" };
      if (channel === "codex:thread:delete-archived" && threadId === "beta") return true;
      throw new Error(`Unexpected ${channel}`);
    });
    const view = renderPage();

    expect(await view.findByText("Alpha task")).toBeTruthy();
    fireEvent.change(view.getByRole("textbox", { name: "Search archived chats" }), {
      target: { value: "beta" },
    });
    await waitFor(() => expect(view.queryByText("Alpha task")).toBeNull());
    fireEvent.change(view.getByRole("textbox", { name: "Search archived chats" }), {
      target: { value: "" },
    });
    await act(async () => {
      fireEvent.click(view.getAllByRole("button", { name: "Unarchive" })[0]!);
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("codex:thread:unarchive", "alpha"));
    expect(view.queryByText("Alpha task")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Delete archived chat Beta task" }));
    expect(view.getByRole("dialog")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("codex:thread:delete-archived", "beta");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Delete" }));
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("codex:thread:delete-archived", "beta"),
    );
    expect(view.queryByText("Beta task")).toBeNull();
  });

  test("routes ACP archive lifecycle through the durable Session authority", async () => {
    const acp = chat("acp-thread", {
      backendBinding: {
        kind: "acp",
        agentDefinitionId: "claude-agent-acp",
        instanceConfigId: null,
      },
      sessionId: "session-acp",
      title: "ACP task",
    });
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "codex:sidebar:snapshot") return snapshot([acp]);
      throw new Error(`Unexpected ${channel}`);
    });
    workspaceSessionCommand.mockResolvedValue({ id: "session-acp" });

    const view = renderPage();
    expect(await view.findByText("ACP task")).toBeTruthy();
    expect(subscribeProjectSessionChanges).toHaveBeenCalledOnce();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Unarchive" }));
    });
    await waitFor(() =>
      expect(workspaceSessionCommand).toHaveBeenCalledWith("unarchive", "session-acp"),
    );
    expect(invoke).not.toHaveBeenCalledWith("codex:thread:unarchive", "acp-thread");

    invoke.mockImplementation(async (channel: string) => {
      if (channel === "codex:sidebar:snapshot") return snapshot([acp]);
      throw new Error(`Unexpected ${channel}`);
    });
    const deleteView = renderPage();
    expect(await deleteView.findByText("ACP task")).toBeTruthy();
    fireEvent.click(deleteView.getByRole("button", { name: "Delete archived chat ACP task" }));
    await act(async () => {
      fireEvent.click(deleteView.getByRole("button", { name: "Delete" }));
    });
    await waitFor(() =>
      expect(workspaceSessionCommand).toHaveBeenCalledWith("delete", "session-acp"),
    );
    expect(invoke).not.toHaveBeenCalledWith("codex:thread:delete-archived", "acp-thread");
  });

  test("deletes the selected archived chats sequentially in order", async () => {
    const chats = ["alpha", "beta", "gamma"].map((id) => chat(id));
    const releases = new Map<string, () => void>();
    const deleted: string[] = [];
    invoke.mockImplementation(async (channel: string, threadId?: string) => {
      if (channel === "codex:sidebar:snapshot") return snapshot(chats);
      if (channel !== "codex:thread:delete-archived" || !threadId)
        throw new Error(`Unexpected ${channel}`);
      deleted.push(threadId);
      await new Promise<void>((resolve) => releases.set(threadId, resolve));
      return true;
    });
    const view = renderPage();
    expect(await view.findByText("Chat alpha")).toBeTruthy();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Delete all" }));
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Delete" }));
    });
    for (const [index, id] of ["alpha", "beta", "gamma"].entries()) {
      await waitFor(() => expect(releases.has(id)).toBe(true));
      expect(deleted).toEqual(["alpha", "beta", "gamma"].slice(0, index + 1));
      await act(async () => {
        releases.get(id)!();
        await Promise.resolve();
      });
    }
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(deleted).toEqual(["alpha", "beta", "gamma"]);
    expect(successToast).toHaveBeenCalledWith("Deleted 3 archived chats");
    expect(dangerToast).not.toHaveBeenCalled();
  });

  test("stops bulk deletion at the first error and refreshes the remaining targets", async () => {
    const chats = ["alpha", "beta", "gamma"].map((id) => chat(id));
    let releaseFirst: (() => void) | undefined;
    let snapshotReads = 0;
    const deleted: string[] = [];
    invoke.mockImplementation(async (channel: string, threadId?: string) => {
      if (channel === "codex:sidebar:snapshot") {
        snapshotReads++;
        return snapshot(snapshotReads === 1 ? chats : chats.slice(1));
      }
      if (channel !== "codex:thread:delete-archived" || !threadId)
        throw new Error(`Unexpected ${channel}`);
      deleted.push(threadId);
      if (threadId === "beta") throw new Error("beta is still in use");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return true;
    });
    const view = renderPage();
    expect(await view.findByText("Chat alpha")).toBeTruthy();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Delete all" }));
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Delete" }));
    });
    await waitFor(() => expect(releaseFirst).toBeDefined());
    expect(deleted).toEqual(["alpha"]);
    expect(snapshotReads).toBe(1);
    await act(async () => {
      releaseFirst!();
      await Promise.resolve();
    });
    await waitFor(() => expect(snapshotReads).toBe(2));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(deleted).toEqual(["alpha", "beta"]);
    expect(view.queryByText("Chat alpha")).toBeNull();
    expect(view.getByText("Chat beta")).toBeTruthy();
    expect(view.getByText("Chat gamma")).toBeTruthy();
    expect(dangerToast).toHaveBeenCalledWith("Failed to delete archived chats", {
      description: "beta is still in use",
    });
    expect(successToast).not.toHaveBeenCalled();
  });
});
