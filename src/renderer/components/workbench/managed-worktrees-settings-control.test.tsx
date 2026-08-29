import { act, fireEvent } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import type {
  ManagedWorktreeRecord,
  ManagedWorktreeSettings,
  UpdateManagedWorktreeSettingsInput,
} from "@/lib/types";
import { render, settleAsyncRender } from "@/test/dom";
import {
  ManagedWorktreesSettingControl,
  type ManagedWorktreesSettingsService,
} from "./managed-worktrees-settings-control";

const SETTINGS: ManagedWorktreeSettings = {
  worktreeRoot: null,
  autoDeleteEnabled: true,
  autoDeleteLimit: 15,
};

const INVENTORY: ManagedWorktreeRecord[] = [
  {
    hostId: "local",
    path: "/managed/alpha/a1b2/alpha",
    exists: true,
    repositoryPath: "/repositories/alpha",
    createdAtMs: 100,
    conversations: [
      {
        threadId: "thread-alpha",
        projectId: "project-alpha",
        projectName: "Alpha",
        sessionId: "session-alpha",
        sessionTitle: "Investigate parser",
        threadName: "Parser task",
        archived: false,
        updatedAt: 200,
      },
    ],
  },
  {
    hostId: "ssh:build-box",
    path: "/srv/worktrees/c3d4/beta",
    exists: true,
    repositoryPath: "/repositories/beta",
    createdAtMs: 90,
    conversations: [],
  },
  {
    hostId: "local",
    path: "/managed/alpha/e5f6/residue",
    exists: true,
    repositoryPath: null,
    createdAtMs: 80,
    conversations: [],
  },
];

function createService(input?: {
  settings?: ManagedWorktreeSettings;
  inventory?: ManagedWorktreeRecord[];
  listError?: Error;
}): ManagedWorktreesSettingsService & {
  updateSettings: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
} {
  let settings = input?.settings ?? SETTINGS;
  const updateSettings = vi.fn(async (patch: UpdateManagedWorktreeSettingsInput) => {
    settings = { ...settings, ...patch };
    return settings;
  });
  const deleteWorktree = vi.fn(async () => true);
  const list = vi.fn(async (hostId: string) => {
    if (input?.listError) throw input.listError;
    return (input?.inventory ?? INVENTORY).filter((record) => record.hostId === hostId);
  });
  return {
    getSettings: async () => settings,
    getExecutionHosts: async () => ({
      sshHosts: [
        {
          id: "ssh:build-box",
          displayName: "Build box",
          kind: "ssh",
          sshAlias: "build-box",
          port: null,
          managedRoot: "/srv/worktrees",
          repositoryRoots: [],
          codexBinary: null,
          codexHome: null,
          enabled: true,
        },
      ],
    }),
    updateSettings,
    list,
    delete: deleteWorktree,
  };
}

describe("ManagedWorktreesSettingControl", () => {
  test("groups physical worktrees and saves root and limit from their keyboard contracts", async () => {
    const service = createService();
    const openedThreads: string[] = [];
    const view = render(
      <ManagedWorktreesSettingControl
        open
        service={service}
        onOpenThread={(threadId) => {
          openedThreads.push(threadId);
        }}
      />,
    );
    await settleAsyncRender();

    expect(view.getByRole("heading", { name: "/repositories/alpha" })).toBeTruthy();
    expect(view.getByRole("heading", { name: "Other worktrees" })).toBeTruthy();
    expect(view.queryByRole("heading", { name: "/repositories/beta" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Investigate parser" }));
    expect(openedThreads).toEqual(["thread-alpha"]);

    const root = view.getByRole("textbox", { name: "Worktree root" });
    fireEvent.change(root, { target: { value: "/custom/worktrees" } });
    await act(async () => {
      fireEvent.keyDown(root, { key: "s", metaKey: true });
      await settleAsyncRender();
    });
    expect(service.updateSettings).toHaveBeenCalledWith({
      worktreeRoot: "/custom/worktrees",
    });
    expect(service.list).toHaveBeenCalledTimes(2);

    const limit = view.getByRole("spinbutton", { name: "Auto-delete limit" });
    fireEvent.change(limit, { target: { value: "24" } });
    limit.focus();
    await act(async () => {
      fireEvent.keyDown(limit, { key: "Enter" });
      await Promise.resolve();
    });
    expect(service.updateSettings).toHaveBeenCalledWith({ autoDeleteLimit: 24 });
  });

  test("switches inventory to one selected host and keeps remote settings read-only", async () => {
    const service = createService();
    const view = render(<ManagedWorktreesSettingControl open service={service} />);
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Execution host" }));
      await settleAsyncRender();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Build box" }));
      await settleAsyncRender();
    });

    expect(view.getByRole("heading", { name: "/repositories/beta" })).toBeTruthy();
    expect(view.queryByRole("heading", { name: "/repositories/alpha" })).toBeNull();
    expect(
      (view.getByRole("textbox", { name: "Worktree root" }) as HTMLInputElement).disabled,
    ).toBe(true);
  });

  test("requires confirmation before disabling cleanup and restores focus when cancelled", async () => {
    const service = createService();
    const view = render(<ManagedWorktreesSettingControl open service={service} />);
    await settleAsyncRender();

    const toggle = view.getByRole("switch", { name: "Automatically delete old worktrees" });
    toggle.focus();
    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    expect(view.getByRole("dialog", { name: "Disable automatic worktree deletion?" })).toBeTruthy();
    expect(service.updateSettings).not.toHaveBeenCalledWith({ autoDeleteEnabled: false });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Keep automatic deletion" }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Disable automatic deletion" }));
      await Promise.resolve();
    });
    expect(service.updateSettings).toHaveBeenCalledWith({ autoDeleteEnabled: false });
  });

  test("deletes the selected host/path only after the service succeeds", async () => {
    const service = createService();
    const view = render(<ManagedWorktreesSettingControl open service={service} />);
    await settleAsyncRender();

    const button = view.getByRole("button", {
      name: "Delete worktree /managed/alpha/a1b2/alpha",
    });
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });
    expect(service.delete).toHaveBeenCalledWith("local", "/managed/alpha/a1b2/alpha");
    expect(view.queryByText("Investigate parser")).toBeNull();
  });

  test("projects inventory failures to a stable message without leaking internal errors", async () => {
    const service = createService({
      listError: new Error("CodexIpcError: worktree worker has 32 pending requests"),
    });
    const view = render(<ManagedWorktreesSettingControl open service={service} />);
    await settleAsyncRender();

    expect(view.getByText("Something went wrong while loading worktrees.")).toBeTruthy();
    expect(view.queryByText(/CodexIpcError|pending requests/u)).toBeNull();
    expect(view.getByRole("button", { name: "Refresh worktrees" })).toBeTruthy();
  });
});
