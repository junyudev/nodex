import { describe, expect, test } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type {
  CodexPendingWorktreeEntry,
  CodexPendingWorktreeThreadResolution,
  CodexPendingWorktreesChangedEvent,
} from "../../../shared/codex-pending-worktree";
import { renderWithMaitai } from "../../test/thread-maitai";
import {
  PendingWorktreeRoute,
  PendingWorktreeRouteView,
  type PendingWorktreeRouteTransport,
} from "./pending-worktree-route";

const CLIENT_THREAD_ID = "client-new-thread:11111111-1111-4111-8111-111111111111";

function render(element: ReactElement) {
  return renderWithMaitai(<NodexTooltipProvider>{element}</NodexTooltipProvider>);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type StartConversationEntry = Extract<
  CodexPendingWorktreeEntry,
  { readonly launchMode: "start-conversation" }
>;

function makeEntry(overrides: Partial<StartConversationEntry> = {}): StartConversationEntry {
  return {
    id: "local:pending-1",
    hostId: "local",
    label: "Prepare an isolated workspace",
    sourceWorkspaceRoot: "/repo/nodex",
    startingState: { type: "branch", branchName: "main" },
    localEnvironmentConfigPath: null,
    prompt: "Create an isolated workspace and implement the task.",
    launchMode: "start-conversation",
    firstSubmission: {
      launchId: "01991e60-b800-7000-8000-000000000101",
      clientUserMessageId: "01991e60-b800-7000-8000-000000000102",
    },
    clientThreadId: CLIENT_THREAD_ID,
    startConversationParamsInput: {
      input: [],
      commentAttachments: [],
      workspaceRoots: ["/repo"],
      cwd: "/repo",
      fileAttachments: [],
      addedFiles: [],
      agentMode: "auto",
      permissionProfileId: undefined,
      shouldSendPermissionOverrides: true,
      model: null,
      serviceTier: null,
      reasoningEffort: null,
      collaborationMode: null,
      config: {},
      threadSource: "subagent",
      workspaceKind: "project",
      serviceName: undefined,
      projectAssignment: {
        projectKind: "local",
        projectId: "project-pending",
        pendingCoreUpdate: false,
      },
    },
    sourceConversationId: null,
    sourceCollaborationMode: null,
    createdAt: 1,
    attempt: 1,
    phase: "queued",
    labelEdited: false,
    worktreeOutputText: "",
    setupOutputText: "",
    errorMessage: null,
    worktreeWorkspaceRoot: null,
    worktreeGitRoot: null,
    needsAttention: false,
    isPinned: false,
    pinnedBeforeThreadId: null,
    ...overrides,
  };
}

class TestPendingWorktreeTransport implements PendingWorktreeRouteTransport {
  entries: CodexPendingWorktreeEntry[];
  resolution: CodexPendingWorktreeThreadResolution | null;
  calls: string[] = [];
  private readonly listeners = new Set<(entries: CodexPendingWorktreesChangedEvent) => void>();

  constructor(
    entry: CodexPendingWorktreeEntry | null,
    resolution: CodexPendingWorktreeThreadResolution | null,
  ) {
    this.entries = entry ? [entry] : [];
    this.resolution = resolution;
  }

  list = async () => this.entries;

  resolveThread = async () => this.resolution;

  autoFix = async (hostId: string, pendingWorktreeId: string) => {
    this.calls.push(`auto-fix:${hostId}:${pendingWorktreeId}`);
    return {
      pendingWorktreeId: `${hostId}:repair`,
      clientThreadId: "client-new-thread:repair",
    };
  };

  retry = async (hostId: string, pendingWorktreeId: string) => {
    this.calls.push(`retry:${hostId}:${pendingWorktreeId}`);
  };

  workLocally = async (hostId: string, pendingWorktreeId: string) => {
    this.calls.push(`work-locally:${hostId}:${pendingWorktreeId}`);
    return { threadId: "thread-local" };
  };

  continue = async (hostId: string, pendingWorktreeId: string) => {
    this.calls.push(`continue:${hostId}:${pendingWorktreeId}`);
  };

  cancel = async (hostId: string, pendingWorktreeId: string) => {
    this.calls.push(`cancel:${hostId}:${pendingWorktreeId}`);
  };

  discardForkSidePanelTransfer = async (pendingWorktreeId: string) => {
    this.calls.push(`discard-transfer:${pendingWorktreeId}`);
  };

  rename = async (hostId: string, pendingWorktreeId: string, label: string) => {
    this.calls.push(`rename:${hostId}:${pendingWorktreeId}:${label}`);
  };

  setPinned = async (hostId: string, pendingWorktreeId: string, isPinned: boolean) => {
    this.calls.push(`pin:${hostId}:${pendingWorktreeId}:${String(isPinned)}`);
  };

  clearAttention = async (hostId: string, pendingWorktreeId: string) => {
    this.calls.push(`clear-attention:${hostId}:${pendingWorktreeId}`);
  };

  subscribe = (listener: (entries: CodexPendingWorktreesChangedEvent) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  emit(entry: CodexPendingWorktreeEntry): void {
    this.emitEntries([entry]);
  }

  emitEntries(entries: CodexPendingWorktreeEntry[]): void {
    this.entries = entries;
    for (const listener of this.listeners) listener(this.entries);
  }
}

function waitingResolution(entry: CodexPendingWorktreeEntry): CodexPendingWorktreeThreadResolution {
  if (entry.launchMode === "create-stable-worktree") {
    throw new Error("A stable worktree has no client thread id");
  }
  return {
    state: "waiting",
    clientThreadId: entry.clientThreadId,
    pendingWorktreeId: entry.id,
  };
}

function startingResolution(entry: StartConversationEntry): CodexPendingWorktreeThreadResolution {
  return {
    state: "starting",
    clientThreadId: entry.clientThreadId,
    pendingWorktreeId: entry.id,
  };
}

describe("PendingWorktreeRoute", () => {
  test("streams queued and setup output from typed pending-worktree snapshots", async () => {
    const queued = makeEntry();
    const transport = new TestPendingWorktreeTransport(queued, waitingResolution(queued));
    const view = render(
      <PendingWorktreeRoute
        clientThreadId={CLIENT_THREAD_ID}
        transport={transport}
        onClose={() => undefined}
        onOpenThread={async () => true}
      />,
    );

    expect(
      Boolean(
        await view.findByText("Creating a worktree", {
          selector: ".loading-shimmer-pure-text",
        }),
      ),
    ).toBe(true);
    expect(Boolean(view.getByText("Preparing workspace"))).toBe(true);
    expect(Boolean(view.getByText("Checking out files"))).toBe(true);
    expect(Boolean(view.getByText("Create an isolated workspace and implement the task."))).toBe(
      true,
    );
    expect(Boolean(view.getByRole("button", { name: "Work locally" }))).toBe(true);
    expect(Boolean(view.getByRole("button", { name: "Cancel" }))).toBe(true);

    const settingUp = makeEntry({
      phase: "setting-up",
      worktreeOutputText: "[info] Worktree created\n",
      setupOutputText: "\u001b[32mbun install\u001b[0m\n",
      worktreeGitRoot: "/repo/worktrees/task",
      worktreeWorkspaceRoot: "/repo/worktrees/task",
      localEnvironmentConfigPath: "/repo/nodex/.codex/environments/default.toml",
    });
    await act(async () => {
      transport.emit(settingUp);
      await Promise.resolve();
    });

    expect(Boolean(await view.findByText("Setting up environment"))).toBe(true);
    expect(Boolean(view.getByRole("button", { name: "More details" }))).toBe(true);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "More details" }));
      await Promise.resolve();
    });
    expect(Boolean(view.getByText("bun install"))).toBe(true);
    expect(view.getByRole("button", { name: "Less details" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect((view.container.textContent ?? "").includes("\u001b")).toBe(false);
  });

  test("cancels only active worktree creation and exits the route", async () => {
    const queued = makeEntry({ phase: "creating" });
    const transport = new TestPendingWorktreeTransport(queued, waitingResolution(queued));
    let closeCount = 0;
    let handedOffPrompt = "";
    const view = render(
      <PendingWorktreeRoute
        clientThreadId={CLIENT_THREAD_ID}
        transport={transport}
        onClose={() => {
          closeCount += 1;
        }}
        onCancelToSource={(entry) => {
          handedOffPrompt = entry.prompt;
        }}
        onOpenThread={async () => true}
      />,
    );

    const cancel = await view.findByRole("button", { name: "Cancel" });
    await waitFor(() => {
      expect(transport.calls[0]).toBe("clear-attention:local:local:pending-1");
    });
    await act(async () => {
      fireEvent.click(cancel);
      await Promise.resolve();
    });

    expect(transport.calls.join(",")).toBe(
      "clear-attention:local:local:pending-1,cancel:local:local:pending-1,discard-transfer:local:pending-1",
    );
    expect(closeCount).toBe(1);
    expect(handedOffPrompt).toBe("Create an isolated workspace and implement the task.");
  });

  test("works locally from the active setup without changing client route identity", async () => {
    const queued = makeEntry({ phase: "creating" });
    const transport = new TestPendingWorktreeTransport(queued, waitingResolution(queued));
    const view = render(
      <PendingWorktreeRoute
        clientThreadId={CLIENT_THREAD_ID}
        transport={transport}
        onClose={() => undefined}
        onOpenThread={async () => true}
      />,
    );

    const workLocally = await view.findByRole("button", { name: "Work locally" });
    await waitFor(() => {
      expect(transport.calls[0]).toBe("clear-attention:local:local:pending-1");
    });
    await act(async () => {
      fireEvent.click(workLocally);
      await Promise.resolve();
    });
    expect(transport.calls.join(",")).toBe(
      "clear-attention:local:local:pending-1,work-locally:local:local:pending-1",
    );
  });

  test("hides the pending body until work-locally returns and opens the real thread", async () => {
    const queued = makeEntry({ phase: "creating" });
    const transport = new TestPendingWorktreeTransport(queued, waitingResolution(queued));
    const launch = deferred<{ readonly threadId: string }>();
    transport.workLocally = async (hostId, pendingWorktreeId) => {
      transport.calls.push(`work-locally:${hostId}:${pendingWorktreeId}`);
      transport.emitEntries([]);
      return await launch.promise;
    };
    const opened: string[] = [];
    let closeCount = 0;
    const view = render(
      <PendingWorktreeRoute
        clientThreadId={CLIENT_THREAD_ID}
        transport={transport}
        onClose={() => {
          closeCount += 1;
        }}
        onOpenThread={async (threadId) => {
          opened.push(threadId);
          return true;
        }}
      />,
    );

    const workLocally = await view.findByRole("button", { name: "Work locally" });
    await act(async () => {
      fireEvent.click(workLocally);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(view.queryByTestId("pending-worktree-route-shell")).toBe(null);
    });
    expect(opened.length).toBe(0);

    launch.resolve({ threadId: "thread-local" });
    await waitFor(() => {
      expect(opened.join(",")).toBe("thread-local");
      expect(closeCount).toBe(1);
    });
  });

  test("shows the rejected work-locally launch error without a missing-setup claim", async () => {
    const queued = makeEntry({ phase: "creating" });
    const transport = new TestPendingWorktreeTransport(queued, waitingResolution(queued));
    const launch = deferred<{ readonly threadId: string }>();
    transport.workLocally = async (hostId, pendingWorktreeId) => {
      transport.calls.push(`work-locally:${hostId}:${pendingWorktreeId}`);
      transport.resolution = null;
      transport.emitEntries([]);
      return await launch.promise;
    };
    const view = render(
      <PendingWorktreeRoute
        clientThreadId={CLIENT_THREAD_ID}
        transport={transport}
        onClose={() => undefined}
        onOpenThread={async () => true}
      />,
    );

    const workLocally = await view.findByRole("button", { name: "Work locally" });
    await act(async () => {
      fireEvent.click(workLocally);
      await Promise.resolve();
    });
    expect(view.queryByTestId("pending-worktree-route-shell")).toBe(null);

    launch.reject(new Error("source launch failed"));
    expect(Boolean(await view.findByRole("alert"))).toBe(true);
    expect(Boolean(view.getByText("source launch failed"))).toBe(true);
    expect(view.queryByText("Worktree setup is no longer available")).toBe(null);
  });

  test("clears attention once on route entry without clearing a later failure update", async () => {
    const entry = makeEntry({ needsAttention: true });
    const transport = new TestPendingWorktreeTransport(entry, waitingResolution(entry));
    const view = render(
      <PendingWorktreeRoute
        clientThreadId={CLIENT_THREAD_ID}
        transport={transport}
        onClose={() => undefined}
        onOpenThread={async () => true}
      />,
    );

    await waitFor(() => {
      expect(transport.calls[0]).toBe("clear-attention:local:local:pending-1");
    });

    await act(async () => {
      transport.emit(makeEntry({ needsAttention: false }));
      await Promise.resolve();
    });

    const failed = makeEntry({
      phase: "failed",
      needsAttention: true,
      errorMessage: "Worktree creation failed",
    });
    await act(async () => {
      transport.emit(failed);
      await Promise.resolve();
    });

    expect(Boolean(await view.findByText("Worktree setup failed"))).toBe(true);
    expect(Boolean(view.getByText("Worktree creation failed"))).toBe(true);
    expect(transport.calls.filter((call) => call.startsWith("clear-attention:")).length).toBe(1);
  });

  test("uses the normal thread hierarchy without a private header or fake composer", async () => {
    const entry = makeEntry();
    const transport = new TestPendingWorktreeTransport(entry, waitingResolution(entry));
    const view = render(
      <PendingWorktreeRoute
        clientThreadId={CLIENT_THREAD_ID}
        transport={transport}
        onClose={() => undefined}
        onOpenThread={async () => true}
      />,
    );

    expect(
      Boolean(
        await view.findByText("Creating a worktree", {
          selector: ".loading-shimmer-pure-text",
        }),
      ),
    ).toBe(true);
    expect(
      Boolean(view.container.querySelector("[data-local-conversation-thread-body='true']")),
    ).toBe(true);
    expect(Boolean(view.container.querySelector("[data-user-message-bubble='true']"))).toBe(true);
    expect(
      Boolean(
        view.container.querySelector(
          `[data-client-user-message-id='${entry.firstSubmission.clientUserMessageId}']`,
        ),
      ),
    ).toBe(true);
    expect(Boolean(view.getByRole("button", { name: "Copy message" }))).toBe(true);
    expect(view.queryByRole("heading", { name: entry.label })).toBe(null);
    expect(view.queryByRole("button", { name: "Pin task" })).toBe(null);
    expect(view.queryByRole("button", { name: "Rename task" })).toBe(null);
    expect(view.queryByText("Waiting for worktree setup…")).toBe(null);
  });

  test("renders phase actions in the exact order with static labels while loading", () => {
    const callbacks = {
      onCancel: () => undefined,
      onContinue: () => undefined,
      onAutoFix: () => undefined,
      onEditEnvironment: () => undefined,
      onRetry: () => undefined,
      onWorkLocally: () => undefined,
    };
    const creating = makeEntry({ phase: "creating" });
    const activeView = render(
      <PendingWorktreeRouteView
        {...callbacks}
        entry={creating}
        resolution={waitingResolution(creating)}
        busyAction="cancel"
      />,
    );
    const activeNames = activeView
      .getAllByRole("button")
      .map((button) => button.textContent?.trim())
      .filter((name) => name === "Work locally" || name === "Cancel");
    expect(activeNames).toEqual(["Work locally", "Cancel"]);
    expect(activeView.getByRole("button", { name: "Work locally" }).getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(activeView.getByRole("button", { name: "Cancel" }).getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(activeView.queryByText("Canceling…")).toBe(null);

    const failed = makeEntry({
      phase: "failed",
      errorMessage: "Environment command failed",
      localEnvironmentConfigPath: "/repo/nodex/.codex/environments/default.toml",
      worktreeGitRoot: "/repo/worktrees/task",
      worktreeWorkspaceRoot: "/repo/worktrees/task",
    });
    const failedView = render(
      <PendingWorktreeRouteView
        {...callbacks}
        entry={failed}
        resolution={waitingResolution(failed)}
        busyAction="auto-fix"
      />,
    );
    const failureActionLabels = new Set([
      "Edit environment",
      "Auto-fix",
      "Retry",
      "Continue anyway",
    ]);
    const failureNames = failedView
      .getAllByRole("button")
      .map((button) => button.textContent?.trim())
      .filter((name): name is string => name !== undefined && failureActionLabels.has(name));
    expect(failureNames).toEqual(["Edit environment", "Auto-fix", "Retry", "Continue anyway"]);
    expect(failedView.getByRole("button", { name: "Auto-fix" }).getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(failedView.getByRole("button", { name: "Retry" }).getAttribute("aria-busy")).toBe(null);
    expect(failedView.getByRole("button", { name: "Retry" }).hasAttribute("disabled")).toBe(false);
    expect(failedView.queryByText("Starting…")).toBe(null);
  });

  test("offers Auto-fix, retry, and continue only at a retained setup failure", async () => {
    const failed = makeEntry({
      phase: "failed",
      errorMessage: "Environment command failed",
      setupOutputText: "exit 1\n",
      worktreeGitRoot: "/repo/worktrees/task",
      worktreeWorkspaceRoot: "/repo/worktrees/task",
      localEnvironmentConfigPath: "/repo/nodex/.codex/environments/default.toml",
    });
    const transport = new TestPendingWorktreeTransport(failed, {
      state: "failed",
      clientThreadId: CLIENT_THREAD_ID,
      pendingWorktreeId: failed.id,
      errorMessage: failed.errorMessage,
    });
    const openedPending: string[] = [];
    const view = render(
      <PendingWorktreeRoute
        clientThreadId={CLIENT_THREAD_ID}
        transport={transport}
        onClose={() => undefined}
        onOpenPendingWorktree={(clientThreadId) => {
          openedPending.push(clientThreadId);
        }}
        onOpenThread={async () => true}
      />,
    );

    const retry = await view.findByRole("button", { name: "Retry" });
    const autoFix = view.getByRole("button", { name: "Auto-fix" });
    const continueAnyway = view.getByRole("button", { name: "Continue anyway" });
    expect(view.queryByRole("button", { name: "Cancel" })).toBe(null);
    expect(Boolean(view.getByText("Setting up environment"))).toBe(true);
    expect(Boolean(view.getByText("Worktree setup failed"))).toBe(true);
    expect(view.queryByText("Task failed to start")).toBe(null);

    await act(async () => {
      fireEvent.click(autoFix);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(retry);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(continueAnyway);
      await Promise.resolve();
    });

    expect(transport.calls.join(",")).toBe(
      "clear-attention:local:local:pending-1,auto-fix:local:local:pending-1,retry:local:local:pending-1,continue:local:local:pending-1",
    );
    expect(openedPending.join(",")).toBe("client-new-thread:repair");
    expect(transport.entries[0]?.id).toBe(failed.id);
  });

  test("retries a failed conversation start without exposing setup continuation", async () => {
    const ready = makeEntry({
      phase: "worktree-ready",
      worktreeGitRoot: "/repo/worktrees/task",
      worktreeWorkspaceRoot: "/repo/worktrees/task",
    });
    const transport = new TestPendingWorktreeTransport(ready, {
      state: "failed",
      clientThreadId: CLIENT_THREAD_ID,
      pendingWorktreeId: ready.id,
      errorMessage: null,
    });
    const view = render(
      <PendingWorktreeRoute
        clientThreadId={CLIENT_THREAD_ID}
        transport={transport}
        onClose={() => undefined}
        onOpenThread={async () => true}
      />,
    );

    expect(Boolean(await view.findByRole("button", { name: "Retry" }))).toBe(true);
    expect(view.queryByRole("button", { name: "Continue anyway" })).toBe(null);
    expect(view.queryByRole("button", { name: "Cancel" })).toBe(null);
  });

  test("maps a succeeded client id to the real thread and leaves the pending route", async () => {
    const ready = makeEntry({
      phase: "worktree-ready",
      worktreeGitRoot: "/repo/worktrees/task",
      worktreeWorkspaceRoot: "/repo/worktrees/task",
    });
    const transport = new TestPendingWorktreeTransport(ready, startingResolution(ready));
    const openedThreads: string[] = [];
    let closeCount = 0;
    const view = render(
      <PendingWorktreeRoute
        clientThreadId={CLIENT_THREAD_ID}
        transport={transport}
        onClose={() => {
          closeCount += 1;
        }}
        onOpenThread={async (threadId) => {
          openedThreads.push(threadId);
          return true;
        }}
      />,
    );

    expect(
      Boolean(
        await view.findByText("Starting a task", {
          selector: ".loading-shimmer-pure-text",
        }),
      ),
    ).toBe(true);
    await act(async () => {
      transport.resolution = {
        state: "succeeded",
        clientThreadId: CLIENT_THREAD_ID,
        threadId: "thread-real",
      };
      transport.emitEntries([]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(openedThreads.join(",")).toBe("thread-real");
      expect(closeCount).toBe(1);
    });
  });

  test("keeps a resolved route recoverable when opening the real thread fails", async () => {
    const transport = new TestPendingWorktreeTransport(null, {
      state: "succeeded",
      clientThreadId: CLIENT_THREAD_ID,
      threadId: "thread-real",
    });
    let openAttempts = 0;
    let closeCount = 0;
    const view = render(
      <PendingWorktreeRoute
        clientThreadId={CLIENT_THREAD_ID}
        transport={transport}
        onClose={() => {
          closeCount += 1;
        }}
        onOpenThread={async () => {
          openAttempts += 1;
          return openAttempts > 1;
        }}
      />,
    );

    const retry = await view.findByRole("button", { name: "Retry" });
    expect(Boolean(view.getByRole("alert"))).toBe(true);
    await act(async () => {
      fireEvent.click(retry);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(openAttempts).toBe(2);
      expect(closeCount).toBe(1);
    });
  });
});
