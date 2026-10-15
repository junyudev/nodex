import { describe, expect, test } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type {
  CodexPendingWorktreeCreateResult,
  CodexPendingWorktreeEntry,
} from "../../../shared/codex-pending-worktree";

import { render as renderDom } from "../../test/dom";
import { StableWorktreeCreateDialog } from "./stable-worktree-create-dialog";
import {
  StableWorktreeStatusDialog,
  type StableWorktreeStatusDialogTransport,
} from "./stable-worktree-status-dialog";

type StableWorktreeEntry = Extract<
  CodexPendingWorktreeEntry,
  { readonly launchMode: "create-stable-worktree" }
>;

function render(element: ReactElement) {
  return renderDom(<NodexTooltipProvider>{element}</NodexTooltipProvider>);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeEntry(overrides: Partial<StableWorktreeEntry> = {}): StableWorktreeEntry {
  return {
    id: "local:stable-1",
    hostId: "local",
    label: "Persistent Nodex project",
    sourceWorkspaceRoot: "/repo/nodex",
    startingState: { type: "branch", branchName: "HEAD" },
    localEnvironmentConfigPath: null,
    prompt:
      "Create a new git worktree from HEAD, add it as a project, and keep it until you remove it",
    launchMode: "create-stable-worktree",
    startConversationParamsInput: null,
    sourceConversationId: null,
    sourceCollaborationMode: null,
    createdAt: 1,
    attempt: 1,
    phase: "creating",
    labelEdited: false,
    worktreeOutputText: "Preparing worktree\n",
    setupOutputText: "",
    errorMessage: null,
    worktreeWorkspaceRoot: null,
    worktreeGitRoot: null,
    needsAttention: false,
    isPinned: false,
    pinnedBeforeThreadId: null,
    ...overrides,
    sourceWorkspaceRoots: overrides.sourceWorkspaceRoots ?? ["/repo/nodex"],
  };
}

class TestStableWorktreeTransport implements StableWorktreeStatusDialogTransport {
  entries: readonly CodexPendingWorktreeEntry[];
  calls: string[] = [];
  listPromise: Promise<readonly CodexPendingWorktreeEntry[]> | null = null;
  autoFixPromise: Promise<CodexPendingWorktreeCreateResult> = Promise.resolve({
    pendingWorktreeId: "local:repair-1",
    clientThreadId: "client-new-thread:repair-1",
  });
  private readonly listeners = new Set<(entries: readonly CodexPendingWorktreeEntry[]) => void>();

  constructor(entries: readonly CodexPendingWorktreeEntry[]) {
    this.entries = entries;
  }

  list = () => this.listPromise ?? Promise.resolve(this.entries);

  subscribe = (listener: (entries: readonly CodexPendingWorktreeEntry[]) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clearAttention = async (hostId: string, pendingWorktreeId: string) => {
    this.calls.push(`clear-attention:${hostId}:${pendingWorktreeId}`);
  };

  cancel = async (hostId: string, pendingWorktreeId: string) => {
    this.calls.push(`cancel:${hostId}:${pendingWorktreeId}`);
  };

  autoFix = async (hostId: string, pendingWorktreeId: string) => {
    this.calls.push(`auto-fix:${hostId}:${pendingWorktreeId}`);
    return this.autoFixPromise;
  };

  retry = async (hostId: string, pendingWorktreeId: string) => {
    this.calls.push(`retry:${hostId}:${pendingWorktreeId}`);
  };

  emit(entries: readonly CodexPendingWorktreeEntry[]) {
    this.entries = entries;
    for (const listener of this.listeners) listener(entries);
  }
}

describe("StableWorktreeCreateDialog", () => {
  test("submits the trimmed project name and closes after creation", async () => {
    let createdProjectName = "";
    let closeCount = 0;
    const view = render(
      <StableWorktreeCreateDialog
        open
        initialProjectName="Nodex persistent"
        onOpenChange={(open) => {
          if (!open) closeCount += 1;
        }}
        onCreate={(projectName) => {
          createdProjectName = projectName;
        }}
      />,
    );

    expect(Boolean(view.getByText("Create worktree and save as a project"))).toBe(true);
    expect(
      Boolean(
        view.getByText(
          "Create a new git worktree from HEAD, add it as a project, and keep it until you remove it",
        ),
      ),
    ).toBe(true);

    const input = view.getByRole("textbox", { name: "Project name" });
    fireEvent.input(input, { target: { value: "  Durable project  " } });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Create" }));
      await Promise.resolve();
    });

    expect(createdProjectName).toBe("Durable project");
    expect(closeCount).toBe(1);
  });

  test("disables empty submission and keeps callback failures inline", async () => {
    const view = render(
      <StableWorktreeCreateDialog
        open
        initialProjectName="Project"
        onOpenChange={() => undefined}
        onCreate={() => {
          throw new Error("disk is full");
        }}
      />,
    );
    const input = view.getByRole("textbox", { name: "Project name" });
    const createButton = view.getByRole("button", { name: "Create" }) as HTMLButtonElement;

    fireEvent.input(input, { target: { value: "   " } });
    expect(createButton.disabled).toBe(true);

    fireEvent.input(input, { target: { value: "Project" } });
    await act(async () => {
      fireEvent.click(createButton);
      await Promise.resolve();
    });

    expect(view.getByRole("alert").textContent).toBe(
      "Failed to create permanent worktree: disk is full",
    );
  });
});

describe("StableWorktreeStatusDialog", () => {
  test("shows only Cancel while busy, clears attention once, and closes on cancel", async () => {
    const entry = makeEntry();
    const transport = new TestStableWorktreeTransport([entry]);
    let closeCount = 0;
    const renderDialog = () => (
      <StableWorktreeStatusDialog
        pendingWorktreeId={entry.id}
        transport={transport}
        onClose={() => {
          closeCount += 1;
        }}
        onEditEnvironment={() => undefined}
        onOpenPendingWorktree={() => undefined}
      />
    );
    const view = render(renderDialog());

    expect(Boolean(await view.findByText("Creating a persistent project worktree"))).toBe(true);
    expect(Boolean(view.getByRole("button", { name: "Creating a worktree" }))).toBe(true);
    expect(Boolean(view.getByRole("button", { name: "Cancel" }))).toBe(true);
    expect(view.queryByRole("button", { name: "Work locally" })).toBe(null);
    expect(view.queryByRole("button", { name: "Continue anyway" })).toBe(null);
    expect(view.queryByRole("button", { name: "Retry" })).toBe(null);

    view.rerender(<NodexTooltipProvider>{renderDialog()}</NodexTooltipProvider>);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Cancel" }));
      await Promise.resolve();
    });

    expect(transport.calls.join(",")).toBe(
      "clear-attention:local:local:stable-1,cancel:local:local:stable-1",
    );
    expect(closeCount).toBe(1);
  });

  test("shows the exact failed actions and closes edit and successful Auto-fix", async () => {
    const entry = makeEntry({
      phase: "failed",
      localEnvironmentConfigPath: "/repo/nodex/.codex/environments/default.toml",
      worktreeWorkspaceRoot: "/repo/worktrees/nodex",
      worktreeGitRoot: "/repo/worktrees/nodex",
      errorMessage: "Setup failed",
      setupOutputText: "postinstall failed\n",
    });
    const transport = new TestStableWorktreeTransport([entry]);
    let closeCount = 0;
    let editedEntryId = "";
    let openedClientThreadId = "";
    const view = render(
      <StableWorktreeStatusDialog
        pendingWorktreeId={entry.id}
        transport={transport}
        onClose={() => {
          closeCount += 1;
        }}
        onEditEnvironment={(selectedEntry) => {
          editedEntryId = selectedEntry.id;
        }}
        onOpenPendingWorktree={(clientThreadId) => {
          openedClientThreadId = clientThreadId;
        }}
      />,
    );

    expect(
      Boolean(
        await view.findByRole("button", {
          name: "Failed to set up the environment",
        }),
      ),
    ).toBe(true);
    expect(Boolean(view.getByRole("button", { name: "Edit environment" }))).toBe(true);
    expect(Boolean(view.getByRole("button", { name: "Auto-fix" }))).toBe(true);
    expect(Boolean(view.getByRole("button", { name: "Retry" }))).toBe(true);
    expect(view.queryByRole("button", { name: "Work locally" })).toBe(null);
    expect(view.queryByRole("button", { name: "Continue anyway" })).toBe(null);
    expect(view.queryByRole("button", { name: "Cancel" })).toBe(null);

    fireEvent.click(view.getByRole("button", { name: "Edit environment" }));
    expect(editedEntryId).toBe(entry.id);
    expect(closeCount).toBe(1);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Retry" }));
      fireEvent.click(view.getByRole("button", { name: "Auto-fix" }));
      await Promise.resolve();
    });

    expect(transport.calls.join(",")).toBe(
      "clear-attention:local:local:stable-1,retry:local:local:stable-1,auto-fix:local:local:stable-1",
    );
    expect(closeCount).toBe(2);
    expect(openedClientThreadId).toBe("client-new-thread:repair-1");
  });

  test("requires the config and both worktree roots before offering Auto-fix", async () => {
    const ineligibleEntries = [
      makeEntry({
        phase: "failed",
        localEnvironmentConfigPath: null,
        worktreeWorkspaceRoot: "/repo/worktrees/nodex",
        worktreeGitRoot: "/repo/worktrees/nodex",
      }),
      makeEntry({
        phase: "failed",
        localEnvironmentConfigPath: "/repo/nodex/.codex/environments/default.toml",
        worktreeWorkspaceRoot: null,
        worktreeGitRoot: "/repo/worktrees/nodex",
      }),
      makeEntry({
        phase: "failed",
        localEnvironmentConfigPath: "/repo/nodex/.codex/environments/default.toml",
        worktreeWorkspaceRoot: "/repo/worktrees/nodex",
        worktreeGitRoot: null,
      }),
    ];

    for (const entry of ineligibleEntries) {
      const transport = new TestStableWorktreeTransport([entry]);
      const view = render(
        <StableWorktreeStatusDialog
          pendingWorktreeId={entry.id}
          transport={transport}
          onClose={() => undefined}
          onEditEnvironment={() => undefined}
          onOpenPendingWorktree={() => undefined}
        />,
      );
      expect(Boolean(await view.findByRole("button", { name: "Retry" }))).toBe(true);
      expect(view.queryByRole("button", { name: "Auto-fix" })).toBe(null);
      view.unmount();
    }
  });

  test("closes only after a previously observed entry disappears", async () => {
    const entry = makeEntry();
    const initialList = deferred<readonly CodexPendingWorktreeEntry[]>();
    const transport = new TestStableWorktreeTransport([]);
    transport.listPromise = initialList.promise;
    let closeCount = 0;
    const view = render(
      <StableWorktreeStatusDialog
        pendingWorktreeId={entry.id}
        transport={transport}
        onClose={() => {
          closeCount += 1;
        }}
        onEditEnvironment={() => undefined}
        onOpenPendingWorktree={() => undefined}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(closeCount).toBe(0);
    expect(view.queryByText(entry.label)).toBe(null);

    await act(async () => {
      initialList.resolve([]);
      await initialList.promise;
    });
    expect(closeCount).toBe(0);

    await act(async () => {
      transport.emit([entry]);
      await Promise.resolve();
    });
    expect(Boolean(await view.findByText(entry.label))).toBe(true);

    await act(async () => {
      transport.emit([]);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(closeCount).toBe(1);
    });
    expect(transport.calls.join(",")).toBe("clear-attention:local:local:stable-1");
  });
});
