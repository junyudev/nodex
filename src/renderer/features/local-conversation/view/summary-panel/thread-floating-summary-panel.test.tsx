import {
  afterAll,
  beforeAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  vi,
  test as bunTest,
} from "vite-plus/test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";
import type { ReactElement } from "react";
import type {
  CodexConversationChildMembership,
  CodexConversationSnapshot,
  CodexConversationTurn,
  GitActionStatusResult,
  GitReviewSnapshot,
  GitReviewSource,
} from "../../../../lib/types";
import { NodexTooltipProvider } from "../../../../components/ui/tooltip";
import { buildCodexFileChangeMap } from "../../../../../shared/codex-file-change";
import { buildReviewFileSafety } from "../../../../../shared/review-file-safety";
import { render, textContent } from "../../../../test/dom";
import { TestQueryProvider } from "../../../../test/query";
import type { ThreadPlanSidePanelTarget, ThreadStageActions } from "../../thread-stage-types";

let invokeCalls: unknown[][] = [];
let gitWorkerCalls: Array<{ method: string; params: unknown }> = [];
let mockInvokeImpl: ((channel: string, ...args: unknown[]) => Promise<unknown>) | null = null;
let summaryPanelPendingDefaultsEnabled = false;
const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, "api");
const pendingByDefaultInvokeChannels = new Set([
  "codex:mcp-resource:read",
  "codex:mcp-server-statuses:list",
  "action-status",
  "branch-metadata",
  "review-summary",
  "gh-pr-status",
]);

async function invokeForTest(channel: string, ...args: unknown[]): Promise<unknown> {
  invokeCalls.push([channel, ...args]);
  if (mockInvokeImpl) {
    const result = await mockInvokeImpl(channel, ...args);
    if (
      result !== null ||
      !summaryPanelPendingDefaultsEnabled ||
      !pendingByDefaultInvokeChannels.has(channel)
    ) {
      return result;
    }
  }
  if (summaryPanelPendingDefaultsEnabled && pendingByDefaultInvokeChannels.has(channel)) {
    return await new Promise(() => undefined);
  }
  return null;
}

vi.mock("../../../../lib/api", () => ({
  invoke: invokeForTest,
  subscribeBoardChanges: () => () => undefined,
  subscribeProjectSessionChanges: () => () => undefined,
  subscribeProjectChanges: () => () => undefined,
  subscribeCodexHostMessages: () => () => undefined,
  subscribeCodexEvents: () => () => undefined,
  subscribeDesktopNotificationActions: () => () => undefined,
  subscribeAppUpdateStatus: () => () => undefined,
  getWindowFocusState: async () => true,
  subscribeWindowFocusChanges: () => () => undefined,
  getGitWorkerClient: () => ({
    request: async ({ method, params }: { method: string; params: unknown }) => {
      gitWorkerCalls.push({ method, params });
      const cwd = (params as { cwd?: string }).cwd ?? "/repo/project";
      const readSnapshot = async (source: GitReviewSource) => {
        const snapshot = await mockInvokeImpl?.("review-summary", {
          cwd,
          source,
        });
        if ((snapshot === null || snapshot === undefined) && summaryPanelPendingDefaultsEnabled) {
          return await new Promise<never>(() => undefined);
        }
        return snapshot as GitReviewSnapshot | null | undefined;
      };
      if (method === "stable-metadata") {
        const snapshot = await readSnapshot("branch");
        return {
          cwd,
          root: snapshot?.isGitRepository ? cwd : null,
          gitDir: snapshot?.isGitRepository ? `${cwd}/.git` : null,
          commonDir: snapshot?.isGitRepository ? `${cwd}/.git` : null,
          isGitRepository: snapshot?.isGitRepository ?? false,
          currentBranch: snapshot?.currentBranch ?? null,
          defaultBranch: snapshot?.defaultBranch ?? null,
          errorMessage: snapshot?.errorMessage ?? null,
        };
      }
      if (method === "status-summary") {
        const [staged, unstaged] = await Promise.all([
          readSnapshot("staged"),
          readSnapshot("unstaged"),
        ]);
        return {
          type: "success",
          stagedCount: staged?.files.length ?? 0,
          unstagedCount: unstaged?.files.length ?? 0,
          untrackedCount: 0,
          snapshotGeneration: 1,
        };
      }
      if (method === "branch-metadata") {
        const state = await mockInvokeImpl?.("branch-metadata", cwd);
        return (
          state ?? {
            currentBranch: null,
            defaultBranch: null,
            branches: [],
          }
        );
      }
      if (method === "action-status") {
        return await mockInvokeImpl?.("action-status", { cwd });
      }
      if (method === "checkout-branch" || method === "create-branch") {
        const channel = method === "create-branch" ? "create-branch" : "checkout-branch";
        const value = await mockInvokeImpl?.(channel, params);
        return value instanceof Error
          ? { type: "error", errorMessage: value.message }
          : { type: "success", value };
      }
      if (method === "branch-diff-stats") {
        const snapshot = await readSnapshot("branch");
        const branchFiles = snapshot?.files ?? [];
        const staged = await readSnapshot("staged");
        const unstaged = await readSnapshot("unstaged");
        const files =
          branchFiles.length > 0
            ? branchFiles
            : [...(staged?.files ?? []), ...(unstaged?.files ?? [])];
        return {
          cwd,
          baseRef: snapshot?.baseRef ?? null,
          files,
          fileCount: files.length,
          additions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
          deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
          untrackedFilesOmitted: 0,
          isGitRepository: snapshot?.isGitRepository ?? false,
          currentBranch: snapshot?.currentBranch ?? null,
          defaultBranch: snapshot?.defaultBranch ?? null,
          errorMessage: snapshot?.errorMessage ?? null,
        };
      }
      if (method === "subscribe-live-query") return { subscribed: true };
      if (method === "unsubscribe-live-query") return { unsubscribed: true };
      if (method === "recover-live-query") return { recovered: true };
      if (method === "refresh-live-query") return { refreshed: true };
      throw new Error(`Unexpected Git worker method: ${method}`);
    },
    subscribe: () => () => undefined,
  }),
}));

vi.mock("@/features/user-attachment-image-editor", () => ({
  resolveImageDisplaySource: (source: string) =>
    source.startsWith("/") ? `app://fs/@fs${source}` : source,
  ImagePreviewDialog: ({
    open,
    src,
    alt,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    src: string;
    alt?: string;
  }) =>
    open ? (
      <div data-testid="summary-image-preview">
        <img src={src} alt={alt ?? ""} />
      </div>
    ) : null,
}));

function renderSummary(ui: ReactElement) {
  return render(
    <TestQueryProvider>
      <NodexTooltipProvider>{ui}</NodexTooltipProvider>
    </TestQueryProvider>,
  );
}

function test(name: string, run: () => void | Promise<void>) {
  bunTest(name, async () => {
    await run();
  });
}

async function clickAndAct(target: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(target);
  });
}

async function expectTooltipContent(trigger: HTMLElement, expected: string): Promise<void> {
  expect(trigger.hasAttribute("title")).toBe(false);
  await act(async () => {
    fireEvent.focus(trigger);
    await Promise.resolve();
  });
  await waitFor(() => {
    const visibleCopy = Array.from(document.body.querySelectorAll('[role="tooltip"]')).some(
      (tooltip) => textContent(tooltip).includes(expected),
    );
    if (!visibleCopy) throw new Error(`Expected tooltip copy: ${expected}`);
  });
  await act(async () => {
    fireEvent.blur(trigger);
  });
}

function makeSnapshot(
  source: GitReviewSource,
  additions: number,
  deletions: number,
): GitReviewSnapshot {
  return {
    cwd: "/repo/project",
    source,
    patch: "",
    files:
      additions > 0 || deletions > 0
        ? [
            {
              path: `${source}.ts`,
              previousPath: null,
              status: "modified",
              rawStatus: null,
              oldOid: null,
              newOid: null,
              revision: `test:${source}:${additions}:${deletions}`,
              additions,
              deletions,
              safety: buildReviewFileSafety(),
            },
          ]
        : [],
    isGitRepository: true,
    baseRef: "main",
    currentBranch: "feature/summary-panel",
    defaultBranch: "main",
    errorMessage: null,
    snapshotGeneration: 1,
  };
}

function makeDetachedSnapshot(
  source: GitReviewSource,
  additions: number,
  deletions: number,
): GitReviewSnapshot {
  return {
    ...makeSnapshot(source, additions, deletions),
    currentBranch: null,
  };
}

function makeDefaultBranchSnapshot(
  source: GitReviewSource,
  additions: number,
  deletions: number,
): GitReviewSnapshot {
  return {
    ...makeSnapshot(source, additions, deletions),
    currentBranch: "main",
    defaultBranch: "main",
  };
}

function getBranchSetupInput(expectedValuePart: string): HTMLInputElement {
  const inputs = Array.from(
    document.body.querySelectorAll<HTMLInputElement>('input[aria-label="Branch name"]'),
  );
  const input = inputs.find((candidate) => candidate.value.includes(expectedValuePart));
  if (!input) {
    throw new Error(
      `Expected branch setup input containing ${expectedValuePart}; saw ${inputs.map((candidate) => candidate.value).join(", ") || "no inputs"}.`,
    );
  }

  return input;
}

function makeSubagentMembership(
  overrides: Partial<CodexConversationChildMembership> = {},
): CodexConversationChildMembership {
  return {
    threadId: "child-1",
    parentThreadId: "thread-1",
    role: "backgroundChild",
    actorName: "Scout",
    displayName: "Scout",
    agentRole: "explorer",
    ...overrides,
  };
}

function makeSubagentConversation(
  overrides: Partial<CodexConversationSnapshot> = {},
): CodexConversationSnapshot {
  return {
    threadId: "child-1",
    projectId: "project-1",
    projectName: "Project",
    title: "Scout thread",
    threadName: "Scout thread",
    threadPreview: "Scout thread",
    agentNickname: "Scout",
    agentRole: "explorer",
    statusType: "active",
    archived: false,
    createdAt: 1_000,
    updatedAt: 1_000,
    resumeState: "resumed",
    turns: [],
    requests: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
    pendingSteers: [],
    backgroundTerminalRows: [],
    capabilityFlags: {
      canCollapseTurns: true,
      canEditLastUserTurn: true,
      canForkFromTurn: true,
      canSearch: true,
    },
    ...overrides,
  } as unknown as CodexConversationSnapshot;
}

describe("ThreadFloatingSummaryPanel", () => {
  beforeAll(() => {
    summaryPanelPendingDefaultsEnabled = true;
  });

  beforeEach(() => {
    invokeCalls = [];
    gitWorkerCalls = [];
    mockInvokeImpl = null;
    Object.defineProperty(window, "api", {
      configurable: true,
      value: { invoke: invokeForTest },
    });
  });

  afterEach(async () => {
    await act(async () => {
      cleanup();
      await Promise.resolve();
    });
  });

  afterAll(() => {
    summaryPanelPendingDefaultsEnabled = false;
    invokeCalls = [];
    gitWorkerCalls = [];
    mockInvokeImpl = null;
    if (originalApiDescriptor) {
      Object.defineProperty(window, "api", originalApiDescriptor);
      return;
    }
    delete window.api;
  });

  test("renders the pinned summary without authenticated quota content", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={[]}
        onErrorMessage={() => undefined}
      />,
    );

    const outer = view.container.querySelector('[data-thread-summary-panel-mode="pinned"]');
    const motionShell = outer?.querySelector(".origin-top-right") as HTMLElement | null;
    const widthShell = motionShell?.firstElementChild as HTMLElement | null;
    expect(outer !== null).toBe(true);
    expect(motionShell?.style.opacity).toBe("1");
    expect(motionShell?.style.transform).toBe("none");
    expect(widthShell?.className.includes("pointer-events-auto")).toBe(true);
    expect(widthShell?.style.width).toBe("300px");
    expect(textContent(view.container).includes("Rate limits")).toBe(false);
    expect(textContent(view.container).includes("82% · 61%")).toBe(false);
  });

  test("keeps the hidden Codex shell without running panel side effects", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open={false}
        activeThreadId="thread-1"
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
        onErrorMessage={() => undefined}
      />,
    );

    const outer = view.container.querySelector('[data-thread-summary-panel-open="false"]');
    const motionShell = outer?.querySelector(".origin-top-right") as HTMLElement | null;
    const widthShell = motionShell?.firstElementChild as HTMLElement | null;
    expect(textContent(view.container).includes("Rate limits")).toBe(false);
    expect(invokeCalls.length).toBe(0);
    expect(motionShell?.style.opacity).toBe("0");
    expect(motionShell?.style.transform).toBe("translateX(100%) scale(0.8)");
    expect(widthShell?.style.width).toBe("300px");
    expect(Boolean(view.container.querySelector("[data-testid='thread-summary-panel']"))).toBe(
      true,
    );
  });

  test("uses the Codex instant invisible branch while overlay popover is open", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        hideImmediately
        mounted
        open={false}
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={[]}
        onErrorMessage={() => undefined}
      />,
    );

    const outer = view.container.querySelector(
      "[data-thread-summary-panel-hide-immediately='true']",
    );
    const motionShell = outer?.querySelector(".origin-top-right");
    expect(Boolean(outer)).toBe(true);
    expect((motionShell as HTMLElement | null)?.style.opacity).toBe("0");
    expect((motionShell as HTMLElement | null)?.style.transform).toBe(
      "translateX(100%) scale(0.8)",
    );
  });

  test("renders the right-panel summary as a dismissible popover", async () => {
    const { ThreadSummaryPanelPopover } = await import("./thread-floating-summary-panel");
    const view = renderSummary(
      <ThreadSummaryPanelPopover
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={[]}
        onErrorMessage={() => undefined}
      />,
    );

    const trigger = view.getByRole("button", { name: "Toggle summary" });
    expect(trigger.getAttribute("aria-pressed")).toBe("false");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await clickAndAct(trigger);
    await waitFor(() => {
      const popover = view.container.ownerDocument.body.querySelector(
        '[data-thread-summary-panel-mode="popover"]',
      );
      expect(Boolean(popover)).toBe(true);
    });
    expect(trigger.getAttribute("aria-pressed")).toBe("true");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      fireEvent.pointerDown(view.container.ownerDocument.body);
      fireEvent.mouseDown(view.container.ownerDocument.body);
      fireEvent.click(view.container.ownerDocument.body);
    });
    await waitFor(() => {
      const popover = view.container.ownerDocument.body.querySelector(
        '[data-thread-summary-panel-mode="popover"]',
      );
      expect(Boolean(popover)).toBe(false);
    });
  });

  test("renders git branch with one non-duplicated branch diff total", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel === "branch-metadata") {
        return {
          cwd: "/repo/project",
          currentBranch: "feature/summary-panel",
          branches: [{ name: "feature/summary-panel", current: true }],
          remotes: [],
          errorMessage: null,
        };
      }

      if (channel !== "review-summary") return null;
      const source = (input as { source: GitReviewSource }).source;
      if (source === "unstaged") return makeSnapshot(source, 2, 1);
      if (source === "staged") return makeSnapshot(source, 3, 4);
      return makeSnapshot(source, 5, 6);
    };

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
        onErrorMessage={() => undefined}
      />,
    );

    await waitFor(() => {
      const content = textContent(view.container);
      if (
        !content.includes("feature/summary-panel") ||
        !content.includes("+5") ||
        !content.includes("-6")
      ) {
        throw new Error(`Expected branch and combined diff stats, saw: ${content}`);
      }
    });

    const panelContent = textContent(view.getByTestId("thread-summary-panel"));
    const branchCount = panelContent.split("feature/summary-panel").length - 1;
    expect(branchCount).toBe(1);

    const branchTrigger = view.getByText("feature/summary-panel").closest("[role='button']");
    if (!(branchTrigger instanceof HTMLElement)) throw new Error("Expected branch trigger");
    await expectTooltipContent(branchTrigger, "Switch branch");
    await act(async () => {
      fireEvent.pointerDown(branchTrigger, { button: 0, ctrlKey: false });
      fireEvent.click(branchTrigger);
    });

    const searchInput = await view.findByPlaceholderText("Search branches");
    expect(searchInput !== null).toBe(true);

    expect(invokeCalls.some((call) => call[0] === "review-summary")).toBe(false);
    expect(gitWorkerCalls.some((call) => call.method === "status-summary")).toBe(true);
    expect(gitWorkerCalls.some((call) => call.method === "branch-diff-stats")).toBe(true);
    expect(gitWorkerCalls.some((call) => call.method === "branch-metadata")).toBe(true);
    expect(invokeCalls.some((call) => call[0] === "branch-metadata")).toBe(false);
  });

  test("opens the Review surface from the Changes row using the primary git source", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const openedSources: GitReviewSource[] = [];
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel === "branch-metadata") {
        return {
          cwd: "/repo/project",
          currentBranch: "feature/summary-panel",
          branches: [{ name: "feature/summary-panel", current: true }],
          remotes: [],
          errorMessage: null,
        };
      }

      if (channel !== "review-summary") return null;
      const source = (input as { source: GitReviewSource }).source;
      if (source === "staged") return makeSnapshot(source, 4, 0);
      if (source === "unstaged") return makeSnapshot(source, 1, 0);
      return makeSnapshot(source, 0, 0);
    };

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
        actions={
          {
            onOpenSummaryGitReview: ({ source }) => {
              openedSources.push(source);
            },
          } as Partial<ThreadStageActions> as ThreadStageActions
        }
        onErrorMessage={() => undefined}
      />,
    );

    await waitFor(() => {
      if (!textContent(view.container).includes("+5")) {
        throw new Error("Expected git summary stats to load.");
      }
    });

    await clickAndAct(view.getByText("Changes"));

    expect(openedSources.length).toBe(1);
    expect(openedSources[0]).toBe("staged");
  });

  test("opens the native commit workflow from the Environment git action row", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const openedSources: GitReviewSource[] = [];
    const commitInputs: unknown[] = [];
    const actionStatus: GitActionStatusResult = {
      cwd: "/repo/project",
      isGitRepository: true,
      currentBranch: "feature/summary-panel",
      defaultBranch: "main",
      upstreamBranch: null,
      remotes: ["origin"],
      hasHeadCommit: true,
      hasStagedChanges: true,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUncommittedChanges: true,
      commitsAhead: 0,
      canCommit: true,
      canPush: false,
      pushNeedsUpstream: false,
      errorMessage: null,
    };
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel === "branch-metadata") {
        return {
          cwd: "/repo/project",
          currentBranch: "feature/summary-panel",
          branches: [{ name: "feature/summary-panel", current: true }],
          remotes: [],
          errorMessage: null,
        };
      }

      if (channel === "action-status") return actionStatus;
      if (channel === "git:action:commit") {
        commitInputs.push(input);
        return {
          cwd: "/repo/project",
          status: "success",
          branch: "feature/summary-panel",
          stdout: "",
          stderr: "",
          errorMessage: null,
        };
      }

      if (channel !== "review-summary") return null;
      const source = (input as { source: GitReviewSource }).source;
      if (source === "staged") return makeSnapshot(source, 2, 0);
      return makeSnapshot(source, 0, 0);
    };

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
        actions={
          {
            onOpenSummaryGitReview: ({ source }) => {
              openedSources.push(source);
            },
          } as Partial<ThreadStageActions> as ThreadStageActions
        }
        onErrorMessage={() => undefined}
      />,
    );

    await waitFor(() => {
      if (!textContent(view.container).includes("+2")) {
        throw new Error("Expected staged git summary stats to load.");
      }
    });

    await act(async () => {
      const commitRow = Array.from(
        view.getByTestId("thread-summary-panel").querySelectorAll<HTMLElement>("[role='button']"),
      ).find((row) => textContent(row).includes("Commit or push"));
      expect(Boolean(commitRow)).toBe(true);
      fireEvent.click(commitRow as HTMLElement);
    });

    await waitFor(() => {
      if (!view.getByLabelText("Commit message")) {
        throw new Error("Expected commit workflow dialog to open.");
      }
    });

    await act(async () => {
      const textarea = view.getByLabelText("Commit message") as HTMLTextAreaElement;
      textarea.value = "Update summary panel";
      fireEvent.input(textarea);
    });

    await waitFor(() => {
      const commitButton = view.getByRole("button", { name: "Commit" });
      if (commitButton.hasAttribute("disabled")) {
        throw new Error("Expected commit action to become enabled.");
      }
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Commit" }));
    });

    await waitFor(() => {
      if (commitInputs.length !== 1) {
        throw new Error("Expected commit workflow to call git action IPC.");
      }
    });

    const commitInput = commitInputs[0] as Record<string, unknown>;
    expect(typeof commitInput.operationId).toBe("string");
    expect(
      JSON.stringify({
        ...commitInput,
        operationId: "<operation>",
      }),
    ).toBe(
      JSON.stringify({
        cwd: "/repo/project",
        hostId: "local",
        message: "Update summary panel",
        includeUnstaged: true,
        nextStep: "commit",
        operationId: "<operation>",
      }),
    );
    expect(JSON.stringify(openedSources)).toBe(JSON.stringify([]));
  });

  test("renders a create-branch row for detached Git checkouts", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const actionStatus: GitActionStatusResult = {
      cwd: "/repo/project",
      isGitRepository: true,
      currentBranch: null,
      defaultBranch: "main",
      upstreamBranch: null,
      remotes: ["origin"],
      hasHeadCommit: true,
      hasStagedChanges: true,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUncommittedChanges: true,
      commitsAhead: 0,
      canCommit: true,
      canPush: false,
      pushNeedsUpstream: false,
      errorMessage: null,
    };
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel === "branch-metadata") {
        return {
          cwd: "/repo/project",
          currentBranch: null,
          defaultBranch: "main",
          branches: ["main"],
          errorMessage: null,
        };
      }

      if (channel === "action-status") return actionStatus;
      if (channel !== "review-summary") return null;
      const source = (input as { source: GitReviewSource }).source;
      if (source === "staged") return makeDetachedSnapshot(source, 2, 0);
      return makeDetachedSnapshot(source, 0, 0);
    };

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        activeThreadTitle="Review detached worktree"
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
        onErrorMessage={() => undefined}
      />,
    );

    await waitFor(() => {
      if (!textContent(view.container).includes("+2")) {
        throw new Error("Expected staged git summary stats to load.");
      }
    });

    const createBranchRow = view.getByText("Create branch").closest("[role='button']");
    expect(Boolean(createBranchRow)).toBe(true);

    await act(async () => {
      fireEvent.click(createBranchRow as HTMLElement);
    });

    const branchNameInput = await waitFor(() => getBranchSetupInput("review-detached-worktree"));
    expect(branchNameInput.value.includes("review-detached-worktree")).toBe(true);
  });

  test("creates a branch before opening the detached commit workflow", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const branchCreateInputs: unknown[] = [];
    let branchCreated = false;
    const readStatus = (): GitActionStatusResult => ({
      cwd: "/repo/project",
      isGitRepository: true,
      currentBranch: branchCreated ? "codex/detached-fix" : null,
      defaultBranch: "main",
      upstreamBranch: null,
      remotes: ["origin"],
      hasHeadCommit: true,
      hasStagedChanges: true,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUncommittedChanges: true,
      commitsAhead: 0,
      canCommit: true,
      canPush: false,
      pushNeedsUpstream: false,
      errorMessage: null,
    });
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel === "branch-metadata") {
        return {
          cwd: "/repo/project",
          currentBranch: branchCreated ? "codex/detached-fix" : null,
          defaultBranch: "main",
          branches: branchCreated ? ["codex/detached-fix", "main"] : ["main"],
          errorMessage: null,
        };
      }

      if (channel === "create-branch") {
        branchCreateInputs.push(input);
        branchCreated = true;
        return {
          cwd: "/repo/project",
          currentBranch: "codex/detached-fix",
          defaultBranch: "main",
          branches: ["codex/detached-fix", "main"],
          errorMessage: null,
        };
      }

      if (channel === "action-status") return readStatus();
      if (channel !== "review-summary") return null;
      const source = (input as { source: GitReviewSource }).source;
      if (source === "staged") {
        return branchCreated ? makeSnapshot(source, 2, 0) : makeDetachedSnapshot(source, 2, 0);
      }
      return branchCreated ? makeSnapshot(source, 0, 0) : makeDetachedSnapshot(source, 0, 0);
    };

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        activeThreadTitle="Detached fix"
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
        onErrorMessage={() => undefined}
      />,
    );

    await waitFor(() => {
      if (!textContent(view.container).includes("+2")) {
        throw new Error("Expected staged git summary stats to load.");
      }
    });

    await act(async () => {
      const commitRow = Array.from(
        view.getByTestId("thread-summary-panel").querySelectorAll<HTMLElement>("[role='button']"),
      ).find((row) => textContent(row).includes("Commit or push"));
      expect(Boolean(commitRow)).toBe(true);
      fireEvent.click(commitRow as HTMLElement);
    });

    const branchNameInput = await waitFor(() => getBranchSetupInput("detached-fix"));
    await act(async () => {
      branchNameInput.value = "codex/detached-fix";
      fireEvent.input(branchNameInput);
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Create" }));
    });

    await waitFor(() => {
      if (branchCreateInputs.length !== 1) {
        throw new Error("Expected branch creation before commit workflow.");
      }
    });

    expect(JSON.stringify(branchCreateInputs[0])).toBe(
      JSON.stringify({
        cwd: "/repo/project",
        branch: "codex/detached-fix",
      }),
    );

    await waitFor(() => {
      if (!view.getByLabelText("Commit message")) {
        throw new Error("Expected commit workflow dialog after branch setup.");
      }
    });
  });

  test("renders a create-branch action for managed worktrees on the default branch", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const actionStatus: GitActionStatusResult = {
      cwd: "/repo/project",
      isGitRepository: true,
      currentBranch: "main",
      defaultBranch: "main",
      upstreamBranch: "origin/main",
      remotes: ["origin"],
      hasHeadCommit: true,
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUncommittedChanges: false,
      commitsAhead: 0,
      canCommit: false,
      canPush: false,
      pushNeedsUpstream: false,
      errorMessage: null,
    };
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel === "branch-metadata") {
        return {
          cwd: "/repo/project",
          currentBranch: "main",
          defaultBranch: "main",
          branches: ["main", "feature/summary-panel"],
          errorMessage: null,
        };
      }

      if (channel === "action-status") return actionStatus;
      if (channel !== "review-summary") return null;
      const source = (input as { source: GitReviewSource }).source;
      return makeDefaultBranchSnapshot(source, 0, 0);
    };

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        activeThreadTitle="Default branch worktree"
        activeThreadIsManagedWorktree
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
        onErrorMessage={() => undefined}
      />,
    );

    await waitFor(() => {
      if (!textContent(view.container).includes("Create branch")) {
        throw new Error("Expected default-branch action to load.");
      }
    });

    const rows = Array.from(
      view.getByTestId("thread-summary-panel").querySelectorAll<HTMLElement>("[role='button']"),
    );
    const createBranchRows = rows.filter((row) => textContent(row).includes("Create branch"));
    const branchRows = rows.filter((row) => textContent(row).includes("main"));
    expect(createBranchRows.length).toBe(1);
    expect(branchRows.length > 0).toBe(true);

    await waitFor(() => {
      expect(createBranchRows[0]?.getAttribute("aria-disabled")).not.toBe("true");
    });

    await act(async () => {
      fireEvent.click(createBranchRows[0] as HTMLElement);
    });

    let branchNameInput = undefined as unknown as HTMLInputElement;
    await waitFor(() => {
      branchNameInput = getBranchSetupInput("default-branch-worktree");
    });
    expect(branchNameInput.value.includes("default-branch-worktree")).toBe(true);
  });

  test("creates a branch before opening the managed default-branch push workflow", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const branchCreateInputs: unknown[] = [];
    let branchCreated = false;
    const readStatus = (): GitActionStatusResult => ({
      cwd: "/repo/project",
      isGitRepository: true,
      currentBranch: branchCreated ? "codex/default-worktree" : "main",
      defaultBranch: "main",
      upstreamBranch: branchCreated ? null : "origin/main",
      remotes: ["origin"],
      hasHeadCommit: true,
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUncommittedChanges: false,
      commitsAhead: 1,
      canCommit: false,
      canPush: true,
      pushNeedsUpstream: branchCreated,
      errorMessage: null,
    });
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel === "branch-metadata") {
        return {
          cwd: "/repo/project",
          currentBranch: branchCreated ? "codex/default-worktree" : "main",
          defaultBranch: "main",
          branches: branchCreated ? ["main", "codex/default-worktree"] : ["main"],
          errorMessage: null,
        };
      }

      if (channel === "create-branch") {
        branchCreateInputs.push(input);
        branchCreated = true;
        return {
          cwd: "/repo/project",
          currentBranch: "codex/default-worktree",
          defaultBranch: "main",
          branches: ["main", "codex/default-worktree"],
          errorMessage: null,
        };
      }

      if (channel === "action-status") return readStatus();
      if (channel !== "review-summary") return null;
      const source = (input as { source: GitReviewSource }).source;
      if (source === "branch") {
        return branchCreated ? makeSnapshot(source, 3, 0) : makeDefaultBranchSnapshot(source, 3, 0);
      }
      return branchCreated ? makeSnapshot(source, 0, 0) : makeDefaultBranchSnapshot(source, 0, 0);
    };

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        activeThreadTitle="Default worktree"
        activeThreadIsManagedWorktree
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
        onErrorMessage={() => undefined}
      />,
    );

    await waitFor(() => {
      if (!textContent(view.container).includes("+3")) {
        throw new Error("Expected branch diff stats to load.");
      }
    });

    const commitRow = Array.from(
      view.getByTestId("thread-summary-panel").querySelectorAll<HTMLElement>("[role='button']"),
    ).find((row) => textContent(row).includes("Commit or push"));
    if (!(commitRow instanceof HTMLElement)) throw new Error("Expected commit row");
    await expectTooltipContent(commitRow, "Create branch");
    await act(async () => {
      fireEvent.click(commitRow);
    });

    const branchNameInput = await waitFor(() => getBranchSetupInput("default-worktree"));
    await act(async () => {
      branchNameInput.value = "codex/default-worktree";
      fireEvent.input(branchNameInput);
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Create" }));
    });

    await waitFor(() => {
      if (branchCreateInputs.length !== 1) {
        throw new Error("Expected branch creation before default-branch push workflow.");
      }
    });

    expect(JSON.stringify(branchCreateInputs[0])).toBe(
      JSON.stringify({
        cwd: "/repo/project",
        branch: "codex/default-worktree",
      }),
    );

    await waitFor(() => {
      if (
        !textContent(view.baseElement).includes("Push codex/default-worktree and set upstream.")
      ) {
        throw new Error("Expected push workflow dialog after branch setup.");
      }
      expect(Boolean(view.getByRole("button", { name: "Push" }))).toBe(true);
    });
  });

  test("shows the reference no-changes blocker on the Environment git action row", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const actionStatus: GitActionStatusResult = {
      cwd: "/repo/project",
      isGitRepository: true,
      currentBranch: "feature/summary-panel",
      defaultBranch: "main",
      upstreamBranch: "origin/feature/summary-panel",
      remotes: ["origin"],
      hasHeadCommit: true,
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUncommittedChanges: false,
      commitsAhead: 0,
      canCommit: false,
      canPush: false,
      pushNeedsUpstream: false,
      errorMessage: null,
    };
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel === "branch-metadata") {
        return {
          cwd: "/repo/project",
          currentBranch: "feature/summary-panel",
          branches: [{ name: "feature/summary-panel", current: true }],
          remotes: ["origin"],
          errorMessage: null,
        };
      }

      if (channel === "action-status") return actionStatus;
      if (channel !== "review-summary") return null;
      const source = (input as { source: GitReviewSource }).source;
      return makeSnapshot(source, 0, 0);
    };

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
        onErrorMessage={() => undefined}
      />,
    );

    const noChangesRow = await waitFor(() => {
      const commitRow = Array.from(
        view.getByTestId("thread-summary-panel").querySelectorAll<HTMLElement>("[role='button']"),
      ).find((row) => textContent(row).includes("Commit or push"));
      if (!commitRow) throw new Error("Expected the no-changes blocker row.");
      expect(commitRow.getAttribute("aria-disabled")).toBe("true");
      return commitRow;
    });
    await expectTooltipContent(noChangesRow, "No changes to commit");
  });

  test("shows the reference nothing-to-push blocker on the Environment git action row", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const actionStatus: GitActionStatusResult = {
      cwd: "/repo/project",
      isGitRepository: true,
      currentBranch: "feature/summary-panel",
      defaultBranch: "main",
      upstreamBranch: "origin/feature/summary-panel",
      remotes: ["origin"],
      hasHeadCommit: true,
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUncommittedChanges: false,
      commitsAhead: 0,
      canCommit: false,
      canPush: false,
      pushNeedsUpstream: false,
      errorMessage: null,
    };
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel === "branch-metadata") {
        return {
          cwd: "/repo/project",
          currentBranch: "feature/summary-panel",
          branches: [{ name: "feature/summary-panel", current: true }],
          remotes: ["origin"],
          errorMessage: null,
        };
      }

      if (channel === "action-status") return actionStatus;
      if (channel !== "review-summary") return null;
      const source = (input as { source: GitReviewSource }).source;
      if (source === "branch") return makeSnapshot(source, 2, 0);
      return makeSnapshot(source, 0, 0);
    };

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
        onErrorMessage={() => undefined}
      />,
    );

    const nothingToPushRow = await waitFor(() => {
      const commitRow = Array.from(
        view.getByTestId("thread-summary-panel").querySelectorAll<HTMLElement>("[role='button']"),
      ).find((row) => textContent(row).includes("Commit or push"));
      if (!commitRow) throw new Error("Expected the push blocker row.");
      expect(commitRow.getAttribute("aria-disabled")).toBe("true");
      return commitRow;
    });
    await expectTooltipContent(nothingToPushRow, "No new commits to push");
  });

  test("allows blank commit messages so the native workflow can generate one", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const generateInputs: unknown[] = [];
    const commitInputs: unknown[] = [];
    const actionStatus: GitActionStatusResult = {
      cwd: "/repo/project",
      isGitRepository: true,
      currentBranch: "feature/summary-panel",
      defaultBranch: "main",
      upstreamBranch: null,
      remotes: ["origin"],
      hasHeadCommit: true,
      hasStagedChanges: true,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUncommittedChanges: true,
      commitsAhead: 0,
      canCommit: true,
      canPush: false,
      pushNeedsUpstream: false,
      errorMessage: null,
    };
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel === "branch-metadata") {
        return {
          cwd: "/repo/project",
          currentBranch: "feature/summary-panel",
          branches: [{ name: "feature/summary-panel", current: true }],
          remotes: [],
          errorMessage: null,
        };
      }

      if (channel === "action-status") return actionStatus;
      if (channel === "git:action:commit-message:generate") {
        generateInputs.push(input);
        return {
          cwd: "/repo/project",
          status: "success",
          message: "Generated summary panel",
          stderr: "",
          errorMessage: null,
        };
      }

      if (channel === "git:action:commit") {
        commitInputs.push(input);
        return {
          cwd: "/repo/project",
          status: "success",
          branch: "feature/summary-panel",
          stdout: "",
          stderr: "",
          errorMessage: null,
        };
      }

      if (channel !== "review-summary") return null;
      const source = (input as { source: GitReviewSource }).source;
      if (source === "staged") return makeSnapshot(source, 2, 0);
      return makeSnapshot(source, 0, 0);
    };

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
        onErrorMessage={() => undefined}
      />,
    );

    await waitFor(() => {
      if (!textContent(view.container).includes("+2")) {
        throw new Error("Expected staged git summary stats to load.");
      }
    });

    await act(async () => {
      const commitRow = Array.from(
        view.getByTestId("thread-summary-panel").querySelectorAll<HTMLElement>("[role='button']"),
      ).find((row) => textContent(row).includes("Commit or push"));
      expect(Boolean(commitRow)).toBe(true);
      fireEvent.click(commitRow as HTMLElement);
    });

    await waitFor(() => {
      const textarea = view.getByLabelText("Commit message") as HTMLTextAreaElement;
      expect(textarea.getAttribute("placeholder")).toBe(
        "Commit message (leave blank to generate)…",
      );
      const commitButton = view.getByRole("button", { name: "Commit" });
      if (commitButton.hasAttribute("disabled")) {
        throw new Error("Expected blank commit action to be enabled.");
      }
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Commit" }));
    });

    await waitFor(() => {
      if (generateInputs.length !== 1) {
        throw new Error("Expected blank commit workflow to generate a commit message first.");
      }
      if (commitInputs.length !== 1) {
        throw new Error("Expected blank commit workflow to call git action IPC.");
      }
    });

    const generateInput = generateInputs[0] as Record<string, unknown>;
    expect(typeof generateInput.operationId).toBe("string");
    expect(
      JSON.stringify({
        ...generateInput,
        operationId: "<operation>",
      }),
    ).toBe(
      JSON.stringify({
        cwd: "/repo/project",
        hostId: "local",
        draftMessage: "",
        includeUnstaged: true,
        operationId: "<operation>",
      }),
    );

    const commitInput = commitInputs[0] as Record<string, unknown>;
    expect(typeof commitInput.operationId).toBe("string");
    expect(
      JSON.stringify({
        ...commitInput,
        operationId: "<operation>",
      }),
    ).toBe(
      JSON.stringify({
        cwd: "/repo/project",
        hostId: "local",
        message: "Generated summary panel",
        includeUnstaged: false,
        nextStep: "commit",
        operationId: "<operation>",
      }),
    );
  });

  test("offers push as a commit modal action when branch commits are ready", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const pushInputs: unknown[] = [];
    const actionStatus: GitActionStatusResult = {
      cwd: "/repo/project",
      isGitRepository: true,
      currentBranch: "feature/summary-panel",
      defaultBranch: "main",
      upstreamBranch: "origin/feature/summary-panel",
      remotes: ["origin"],
      hasHeadCommit: true,
      hasStagedChanges: true,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUncommittedChanges: true,
      commitsAhead: 2,
      canCommit: true,
      canPush: true,
      pushNeedsUpstream: false,
      errorMessage: null,
    };
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel === "branch-metadata") {
        return {
          cwd: "/repo/project",
          currentBranch: "feature/summary-panel",
          defaultBranch: "main",
          branches: [{ name: "feature/summary-panel", current: true }],
          remotes: ["origin"],
          errorMessage: null,
        };
      }

      if (channel === "action-status") return actionStatus;
      if (channel === "git:action:push") {
        pushInputs.push(input);
        return {
          cwd: "/repo/project",
          status: "success",
          branch: "feature/summary-panel",
          stdout: "",
          stderr: "",
          errorMessage: null,
        };
      }

      if (channel !== "review-summary") return null;
      const source = (input as { source: GitReviewSource }).source;
      if (source === "staged") return makeSnapshot(source, 2, 0);
      if (source === "branch") return makeSnapshot(source, 3, 0);
      return makeSnapshot(source, 0, 0);
    };

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
        onErrorMessage={() => undefined}
      />,
    );

    await waitFor(() => {
      if (!textContent(view.container).includes("+3")) {
        throw new Error("Expected the branch diff summary to load once.");
      }
    });

    await act(async () => {
      const commitRow = Array.from(
        view.getByTestId("thread-summary-panel").querySelectorAll<HTMLElement>("[role='button']"),
      ).find((row) => textContent(row).includes("Commit or push"));
      expect(Boolean(commitRow)).toBe(true);
      fireEvent.click(commitRow as HTMLElement);
    });

    await waitFor(() => {
      expect(Boolean(view.getByRole("button", { name: "Commit" }))).toBe(true);
      expect(Boolean(view.getByRole("button", { name: "Commit and push" }))).toBe(true);
      expect(Boolean(view.getByRole("button", { name: "Push" }))).toBe(true);
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Push" }));
    });

    await waitFor(() => {
      if (pushInputs.length !== 1) {
        throw new Error("Expected push-only action to call push IPC.");
      }
    });

    const pushInput = pushInputs[0] as Record<string, unknown>;
    expect(pushInput.cwd).toBe("/repo/project");
    expect(typeof pushInput.operationId).toBe("string");
  });

  test("shows generated-message and commit phases for blank commit messages", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const commitInputs: unknown[] = [];
    let resolveGeneration: (value: unknown) => void = () => undefined;
    let resolveCommit: (value: unknown) => void = () => undefined;
    const actionStatus: GitActionStatusResult = {
      cwd: "/repo/project",
      isGitRepository: true,
      currentBranch: "feature/summary-panel",
      defaultBranch: "main",
      upstreamBranch: null,
      remotes: ["origin"],
      hasHeadCommit: true,
      hasStagedChanges: true,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUncommittedChanges: true,
      commitsAhead: 0,
      canCommit: true,
      canPush: false,
      pushNeedsUpstream: false,
      errorMessage: null,
    };
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel === "branch-metadata") {
        return {
          cwd: "/repo/project",
          currentBranch: "feature/summary-panel",
          branches: [{ name: "feature/summary-panel", current: true }],
          remotes: [],
          errorMessage: null,
        };
      }

      if (channel === "action-status") return actionStatus;
      if (channel === "git:action:commit-message:generate") {
        return new Promise((resolve) => {
          resolveGeneration = resolve;
        });
      }

      if (channel === "git:action:commit") {
        commitInputs.push(input);
        return new Promise((resolve) => {
          resolveCommit = resolve;
        });
      }

      if (channel !== "review-summary") return null;
      const source = (input as { source: GitReviewSource }).source;
      if (source === "staged") return makeSnapshot(source, 2, 0);
      return makeSnapshot(source, 0, 0);
    };

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
        onErrorMessage={() => undefined}
      />,
    );

    await waitFor(() => {
      if (!textContent(view.container).includes("+2")) {
        throw new Error("Expected staged git summary stats to load.");
      }
    });

    await act(async () => {
      const commitRow = Array.from(
        view.getByTestId("thread-summary-panel").querySelectorAll<HTMLElement>("[role='button']"),
      ).find((row) => textContent(row).includes("Commit or push"));
      expect(Boolean(commitRow)).toBe(true);
      fireEvent.click(commitRow as HTMLElement);
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Commit" }));
    });

    await waitFor(() => {
      if (!textContent(view.getByTestId("thread-summary-panel")).includes("Generating messages…")) {
        throw new Error("Expected summary row to show the generated-message phase.");
      }
    });

    await act(async () => {
      resolveGeneration({
        cwd: "/repo/project",
        status: "success",
        message: "Generated summary panel",
        stderr: "",
        errorMessage: null,
      });
    });

    await waitFor(() => {
      if (commitInputs.length !== 1) {
        throw new Error("Expected generated commit message to continue into commit IPC.");
      }
      if (!textContent(view.getByTestId("thread-summary-panel")).includes("Committing…")) {
        throw new Error("Expected summary row to show the commit phase after generation.");
      }
    });

    await act(async () => {
      resolveCommit({
        cwd: "/repo/project",
        status: "success",
        branch: "feature/summary-panel",
        stdout: "",
        stderr: "",
        errorMessage: null,
      });
    });
  });

  test("shows the git workflow phase and cancels the active operation from the summary row", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const commitInputs: unknown[] = [];
    const cancelInputs: unknown[] = [];
    let resolveCommit: (value: unknown) => void = () => undefined;
    const actionStatus: GitActionStatusResult = {
      cwd: "/repo/project",
      isGitRepository: true,
      currentBranch: "feature/summary-panel",
      defaultBranch: "main",
      upstreamBranch: null,
      remotes: ["origin"],
      hasHeadCommit: true,
      hasStagedChanges: true,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUncommittedChanges: true,
      commitsAhead: 0,
      canCommit: true,
      canPush: false,
      pushNeedsUpstream: false,
      errorMessage: null,
    };
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel === "branch-metadata") {
        return {
          cwd: "/repo/project",
          currentBranch: "feature/summary-panel",
          branches: [{ name: "feature/summary-panel", current: true }],
          remotes: [],
          errorMessage: null,
        };
      }

      if (channel === "action-status") return actionStatus;
      if (channel === "git:action:cancel") {
        cancelInputs.push(input);
        return { canceled: true };
      }

      if (channel === "git:action:commit") {
        commitInputs.push(input);
        return new Promise((resolve) => {
          resolveCommit = resolve;
        });
      }

      if (channel !== "review-summary") return null;
      const source = (input as { source: GitReviewSource }).source;
      if (source === "staged") return makeSnapshot(source, 2, 0);
      return makeSnapshot(source, 0, 0);
    };

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
        onErrorMessage={() => undefined}
      />,
    );

    await waitFor(() => {
      if (!textContent(view.container).includes("+2")) {
        throw new Error("Expected staged git summary stats to load.");
      }
    });

    await act(async () => {
      const commitRow = Array.from(
        view.getByTestId("thread-summary-panel").querySelectorAll<HTMLElement>("[role='button']"),
      ).find((row) => textContent(row).includes("Commit or push"));
      expect(Boolean(commitRow)).toBe(true);
      fireEvent.click(commitRow as HTMLElement);
    });

    await act(async () => {
      const textarea = view.getByLabelText("Commit message") as HTMLTextAreaElement;
      textarea.value = "Update summary panel";
      fireEvent.input(textarea);
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Commit" }));
    });

    await waitFor(() => {
      if (!textContent(view.getByTestId("thread-summary-panel")).includes("Committing…")) {
        throw new Error("Expected summary row to show the commit phase.");
      }
    });

    await act(async () => {
      const cancelButton = view
        .getByTestId("thread-summary-panel")
        .querySelector<HTMLButtonElement>('[aria-label="Cancel git action"]');
      expect(Boolean(cancelButton)).toBe(true);
      fireEvent.click(cancelButton as HTMLButtonElement);
    });

    await waitFor(() => {
      if (cancelInputs.length !== 1) {
        throw new Error("Expected cancel IPC to be called.");
      }
    });

    const commitInput = commitInputs[0] as Record<string, unknown>;
    const cancelInput = cancelInputs[0] as Record<string, unknown>;
    expect(cancelInput.operationId).toBe(commitInput.operationId);

    await act(async () => {
      resolveCommit({
        cwd: "/repo/project",
        status: "error",
        branch: "feature/summary-panel",
        stdout: "",
        stderr: "",
        errorMessage: "Git action was canceled.",
      });
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  test("opens the native create-pull-request workflow from the Environment PR row", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const openedSources: GitReviewSource[] = [];
    const messageGenerateInputs: unknown[] = [];
    const createPullRequestInputs: unknown[] = [];
    const actionStatus: GitActionStatusResult = {
      cwd: "/repo/project",
      isGitRepository: true,
      currentBranch: "feature/summary-panel",
      defaultBranch: "main",
      upstreamBranch: "origin/feature/summary-panel",
      remotes: ["origin"],
      hasHeadCommit: true,
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUncommittedChanges: false,
      commitsAhead: 0,
      canCommit: false,
      canPush: false,
      pushNeedsUpstream: false,
      errorMessage: null,
    };
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel === "branch-metadata") {
        return {
          cwd: "/repo/project",
          currentBranch: "feature/summary-panel",
          defaultBranch: "main",
          branches: [{ name: "feature/summary-panel", current: true }],
          remotes: [],
          errorMessage: null,
        };
      }

      if (channel === "action-status") return actionStatus;
      if (channel === "gh-pr-status") {
        return {
          cwd: "/repo/project",
          available: true,
          status: "error",
          disabledReason: null,
          prNumber: null,
          title: null,
          url: null,
          state: null,
          mergeStateStatus: null,
          message: "no pull requests found",
        };
      }

      if (channel === "git:action:pull-request-message:generate") {
        messageGenerateInputs.push(input);
        return {
          cwd: "/repo/project",
          status: "success",
          title: "Generated PR title",
          body: "Generated PR body",
          stderr: "",
          errorMessage: null,
        };
      }

      if (channel === "gh-pr-create") {
        createPullRequestInputs.push(input);
        return {
          cwd: "/repo/project",
          available: true,
          disabledReason: null,
          url: "https://github.com/acme/project/pull/12",
          message: null,
        };
      }

      if (channel !== "review-summary") return null;
      const source = (input as { source: GitReviewSource }).source;
      return makeSnapshot(source, 0, 0);
    };

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
        actions={
          {
            onOpenSummaryGitReview: ({ source }) => {
              openedSources.push(source);
            },
          } as Partial<ThreadStageActions> as ThreadStageActions
        }
        onErrorMessage={() => undefined}
      />,
    );

    await waitFor(() => {
      const createPullRequestRow = view.getByText("Create pull request").closest("[role='button']");
      if (createPullRequestRow?.getAttribute("aria-disabled") === "true") {
        throw new Error("Expected create pull request row to become enabled.");
      }
    });

    await act(async () => {
      fireEvent.click(view.getByText("Create pull request"));
    });

    await waitFor(() => {
      if (!view.queryByLabelText("Title")) {
        throw new Error("Expected native create PR dialog to open.");
      }
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Create PR" }));
    });

    await waitFor(() => {
      if (messageGenerateInputs.length !== 1) {
        throw new Error("Expected blank PR title/body to be generated before creating the PR.");
      }
      if (createPullRequestInputs.length !== 1) {
        throw new Error("Expected gh-pr-create to be called.");
      }
    });

    expect(JSON.stringify(messageGenerateInputs[0])).toBe(
      JSON.stringify({
        cwd: "/repo/project",
        hostId: "local",
        title: "",
        body: "",
        headBranch: "feature/summary-panel",
        baseBranch: "main",
        operationId: (messageGenerateInputs[0] as { operationId: string }).operationId,
      }),
    );
    expect(typeof (messageGenerateInputs[0] as { operationId: unknown }).operationId).toBe(
      "string",
    );
    expect(JSON.stringify(createPullRequestInputs[0])).toBe(
      JSON.stringify({
        cwd: "/repo/project",
        title: "Generated PR title",
        body: "Generated PR body",
        base: "main",
        head: "feature/summary-panel",
        draft: false,
      }),
    );
    expect(JSON.stringify(openedSources)).toBe(JSON.stringify([]));
  });

  test("creates a branch before opening the managed default-branch create-pr workflow", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const branchCreateInputs: unknown[] = [];
    let branchCreated = false;
    const readStatus = (): GitActionStatusResult => ({
      cwd: "/repo/project",
      isGitRepository: true,
      currentBranch: branchCreated ? "codex/default-pr-worktree" : "main",
      defaultBranch: "main",
      upstreamBranch: branchCreated ? null : "origin/main",
      remotes: ["origin"],
      hasHeadCommit: true,
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUncommittedChanges: false,
      commitsAhead: 0,
      canCommit: false,
      canPush: false,
      pushNeedsUpstream: branchCreated,
      errorMessage: null,
    });
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel === "branch-metadata") {
        return {
          cwd: "/repo/project",
          currentBranch: branchCreated ? "codex/default-pr-worktree" : "main",
          defaultBranch: "main",
          branches: branchCreated ? ["main", "codex/default-pr-worktree"] : ["main"],
          errorMessage: null,
        };
      }

      if (channel === "create-branch") {
        branchCreateInputs.push(input);
        branchCreated = true;
        return {
          cwd: "/repo/project",
          currentBranch: "codex/default-pr-worktree",
          defaultBranch: "main",
          branches: ["main", "codex/default-pr-worktree"],
          errorMessage: null,
        };
      }

      if (channel === "action-status") return readStatus();
      if (channel === "gh-pr-status") {
        return {
          cwd: "/repo/project",
          available: true,
          status: "error",
          disabledReason: null,
          prNumber: null,
          title: null,
          url: null,
          state: null,
          mergeStateStatus: null,
          message: "no pull requests found",
        };
      }
      if (channel !== "review-summary") return null;
      const source = (input as { source: GitReviewSource }).source;
      return branchCreated ? makeSnapshot(source, 0, 0) : makeDefaultBranchSnapshot(source, 0, 0);
    };

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        activeThreadTitle="Default PR worktree"
        activeThreadIsManagedWorktree
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
        onErrorMessage={() => undefined}
      />,
    );

    const createPullRequestRow = await waitFor(() => {
      const createPullRequestRow = view.getByText("Create pull request").closest("[role='button']");
      if (!(createPullRequestRow instanceof HTMLElement)) {
        throw new Error("Expected create pull request to require branch setup.");
      }
      return createPullRequestRow;
    });
    await expectTooltipContent(createPullRequestRow, "Create branch");

    await act(async () => {
      fireEvent.click(view.getByText("Create pull request"));
    });

    const branchNameInput = await waitFor(() => getBranchSetupInput("default-pr-worktree"));
    await act(async () => {
      branchNameInput.value = "codex/default-pr-worktree";
      fireEvent.input(branchNameInput);
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Create" }));
    });

    await waitFor(() => {
      if (branchCreateInputs.length !== 1) {
        throw new Error("Expected branch creation before create-pr workflow.");
      }
      if (!view.queryByLabelText("Title")) {
        throw new Error("Expected create-pr dialog after branch setup.");
      }
    });

    expect(JSON.stringify(branchCreateInputs[0])).toBe(
      JSON.stringify({
        cwd: "/repo/project",
        branch: "codex/default-pr-worktree",
      }),
    );
  });

  test("renders available Codex summary sections in source order", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const turns = [
      {
        turnId: "turn-plan",
        items: [
          {
            threadId: "thread-1",
            turnId: "turn-plan",
            itemId: "plan",
            type: "plan",
            kind: "plan",
            semanticKind: "proposedPlan",
            status: "completed",
            role: "assistant",
            markdownText: "# Summary panel parity\n\n- Inspect shell\n- Wire summary",
          },
        ],
        status: "completed",
      },
      {
        items: [
          {
            itemId: "file",
            type: "fileChange",
            fileChange: {
              changes: buildCodexFileChangeMap([
                {
                  path: "src/renderer/app.tsx",
                  type: "update",
                  movePath: null,
                  unifiedDiff: "@@ -1 +1 @@\n-old\n+new",
                },
              ]),
            },
          },
          {
            itemId: "generated-image",
            type: "imageGeneration",
            rawItem: {
              id: "generated-image",
              type: "imageGeneration",
              status: "completed",
              result: "",
              savedPath: "/repo/project/generated-one.png",
            },
          },
          {
            itemId: "agent",
            type: "collabAgentToolCall",
            status: "completed",
            rawItem: {
              tool: "spawnAgent",
              status: "completed",
              receiverThreadIds: ["child-1"],
              receiverThreads: [
                {
                  threadId: "child-1",
                  thread: {
                    nickname: "Scout",
                    model: "gpt-5-codex",
                    agentRole: "explorer",
                  },
                },
              ],
              agentsStates: {
                "child-1": {
                  status: "running",
                  message: null,
                },
              },
              model: "gpt-5-codex",
            },
          },
          {
            itemId: "mcp",
            type: "mcpToolCall",
            mcpToolCall: {
              callId: "mcp",
              functionName: "context7__query",
              pluginId: null,
              mcpAppResourceUri: undefined,
              source: null,
              invocation: {
                server: "context7",
                tool: "query",
                arguments: {},
              },
              result: null,
              durationMs: null,
              completed: false,
            },
          },
          {
            itemId: "web",
            type: "webSearch",
          },
        ],
        status: "inProgress",
      },
    ] as unknown as CodexConversationTurn[];

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={turns}
        childMemberships={[makeSubagentMembership()]}
        knownConversationsById={{}}
        backgroundTerminalRows={[
          {
            id: "terminal-1",
            turnId: "turn-terminal-1",
            command: "bun test",
            cwd: "/repo/project",
            previewLine: "3 pass",
          },
        ]}
        scheduledAutomation={{
          id: "automation-1",
          name: "Review release notes",
          scheduleSummary: "Every weekday",
          nextRunLabel: "tomorrow at 9:00 AM",
        }}
        sideChatRows={[
          {
            id: "side-chat-1",
            title: "Investigate layout",
            status: "Open",
          },
        ]}
        browserRows={[
          {
            id: "browser-1",
            browserTabId: "browser-runtime-1",
            workbenchTabId: null,
            title: "Release notes",
            displayUrl: "example.com",
            url: "https://example.com/release-notes",
            faviconUrl: null,
            isAgentWorking: false,
            isMaterialized: false,
          },
        ]}
        onErrorMessage={() => undefined}
      />,
    );

    const content = textContent(view.container);
    const orderedTitles = [
      "Scheduled",
      "Plan",
      "Outputs",
      "Side chats",
      "Subagents",
      "Tasks",
      "Browser",
      "Sources",
    ];
    const indexes = orderedTitles.map((title) => content.indexOf(title));
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect(indexes.join(",")).toBe(
      indexes
        .slice()
        .sort((left, right) => left - right)
        .join(","),
    );
    expect(content.includes("Automations")).toBe(false);
    expect(content.includes("Review release notes")).toBe(true);
    expect(content.includes("Every weekday")).toBe(true);
    expect(content.includes("Summary panel parity")).toBe(true);
    expect(content.includes("Inspect shell")).toBe(false);
    expect(content.includes("app.tsx")).toBe(false);
    expect(content.includes("Generated image 1")).toBe(true);
    expect(content.includes("Scout")).toBe(true);
    expect(content.includes("Investigate layout")).toBe(true);
    expect(content.includes("Release notes")).toBe(true);
    expect(view.container.querySelector('[aria-label="Context7"]') !== null).toBe(true);
    expect(view.container.querySelector('[aria-label="Web search"]') !== null).toBe(true);
    expect(content.includes("bun test")).toBe(true);
    expect(content.includes("Environment")).toBe(false);
  });

  test("opens the scheduled automation row with the reference action payload", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const openedAutomations: unknown[] = [];
    const actions = {
      onOpenSummaryScheduledAutomation: (input) => {
        openedAutomations.push(input);
      },
    } as Partial<ThreadStageActions> as ThreadStageActions;

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={[]}
        scheduledAutomation={{
          id: "automation-1",
          name: "Review release notes",
          scheduleSummary: "Every weekday",
          nextRunLabel: "tomorrow at 9:00 AM",
        }}
        actions={actions}
        onErrorMessage={() => undefined}
      />,
    );

    const row = view.getByRole("button", { name: "Open scheduled task" });
    await expectTooltipContent(row, "Next run: tomorrow at 9:00 AM");
    expect(textContent(row).includes("Review release notes")).toBe(true);
    expect(textContent(row).includes("Every weekday")).toBe(true);

    await clickAndAct(row);

    const payload = openedAutomations[0] as { automationId?: string; title?: string } | undefined;
    expect(openedAutomations.length).toBe(1);
    expect(payload?.automationId).toBe("automation-1");
    expect(payload?.title).toBe("Review release notes");
  });

  test("opens auxiliary rows and exposes the process manager action", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const openedSideChats: unknown[] = [];
    const openedBrowsers: unknown[] = [];
    const openedTerminals: unknown[] = [];
    let processManagerOpenCount = 0;
    const actions = {
      onOpenSummarySideChatRow: (input) => {
        openedSideChats.push(input);
      },
      onOpenSummaryBrowserRow: (input) => {
        openedBrowsers.push(input);
      },
      onOpenBackgroundTerminalOutput: (row) => {
        openedTerminals.push(row);
      },
      onOpenProcessManager: () => {
        processManagerOpenCount += 1;
      },
    } as Partial<ThreadStageActions> as ThreadStageActions;

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={[]}
        backgroundTerminalRows={[
          {
            id: "terminal-1",
            turnId: "turn-terminal-1",
            command: "bun dev",
            cwd: "/repo/project",
            previewLine: null,
          },
        ]}
        sideChatRows={[
          {
            id: "side-chat-1",
            title: "Investigate layout",
            panelId: "right",
            leafId: "leaf-a",
          },
        ]}
        browserRows={[
          {
            id: "browser-1",
            browserTabId: "browser-runtime-1",
            workbenchTabId: "browser-1",
            title: "Release notes",
            displayUrl: "example.com",
            url: "https://example.com/release-notes",
            faviconUrl: null,
            isAgentWorking: false,
            isMaterialized: true,
            panelId: "bottom",
            leafId: null,
          },
        ]}
        actions={actions}
        onErrorMessage={() => undefined}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Investigate layout" }));
      fireEvent.click(view.getByRole("button", { name: "Release notes example.com" }));
      fireEvent.click(view.getByRole("button", { name: "bun dev" }));
      fireEvent.click(view.getByRole("button", { name: "View all processes" }));
    });

    const sideChatCall = openedSideChats[0] as
      | { rowId?: string; panelId?: string; leafId?: string | null }
      | undefined;
    const browserCall = openedBrowsers[0] as
      | {
          browserTabId?: string;
          rowId?: string;
          panelId?: string;
          leafId?: string | null;
        }
      | undefined;
    const terminalCall = openedTerminals[0] as
      | { id?: string; turnId?: string; command?: string }
      | undefined;
    expect(openedSideChats.length).toBe(1);
    expect(sideChatCall?.rowId).toBe("side-chat-1");
    expect(sideChatCall?.panelId).toBe("right");
    expect(sideChatCall?.leafId).toBe("leaf-a");
    expect(openedBrowsers.length).toBe(1);
    expect(browserCall?.browserTabId).toBe("browser-runtime-1");
    expect(browserCall?.rowId).toBe("browser-1");
    expect(browserCall?.panelId).toBe("bottom");
    expect(browserCall?.leafId).toBe(null);
    expect(openedTerminals.length).toBe(1);
    expect(terminalCall?.id).toBe("terminal-1");
    expect(terminalCall?.turnId).toBe("turn-terminal-1");
    expect(terminalCall?.command).toBe("bun dev");
    expect(String(processManagerOpenCount)).toBe("1");
    expect(textContent(view.container).includes("Tasks")).toBe(true);
    expect(textContent(view.container).includes("Background tasks")).toBe(false);
  });

  test("uses the response-in-progress icon for active side chat rows", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const actions = {
      onOpenSummarySideChatRow: () => undefined,
    } as Partial<ThreadStageActions> as ThreadStageActions;

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={[]}
        sideChatRows={[
          {
            id: "side-chat-active",
            title: "Investigate layout",
            isResponseInProgress: true,
            panelId: "right",
          },
          {
            id: "side-chat-idle",
            title: "Compare bundle",
            isResponseInProgress: false,
            panelId: "right",
          },
        ]}
        actions={actions}
        onErrorMessage={() => undefined}
      />,
    );

    const activeRow = view.getByRole("button", { name: "Investigate layout" });
    const idleRow = view.getByRole("button", { name: "Compare bundle" });
    expect(activeRow.querySelector('[data-activity-spinner="true"]') !== null).toBe(true);
    expect(idleRow.querySelector('[data-activity-spinner="true"]') === null).toBe(true);
  });

  test("renders the Computer Use PiP as a headerless toggle row when state and action exist", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const toggles: boolean[] = [];
    const actions = {
      onOpenSummaryBrowserRow: () => undefined,
      onToggleSummaryComputerUsePip: (nextVisible: boolean) => {
        toggles.push(nextVisible);
      },
    } as Partial<ThreadStageActions> as ThreadStageActions;

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={[]}
        computerUsePip={{ visible: false }}
        backgroundTerminalRows={[
          {
            id: "terminal-1",
            turnId: "turn-terminal-1",
            command: "bun dev",
            cwd: "/repo/project",
            previewLine: null,
          },
        ]}
        browserRows={[
          {
            id: "browser-1",
            browserTabId: "browser-runtime-1",
            workbenchTabId: "browser-1",
            title: "Release notes",
            displayUrl: "example.com",
            url: "https://example.com/release-notes",
            faviconUrl: null,
            isAgentWorking: false,
            isMaterialized: true,
            panelId: "bottom",
            leafId: null,
          },
        ]}
        actions={actions}
        onErrorMessage={() => undefined}
      />,
    );

    const content = textContent(view.container);
    const tasksIndex = content.indexOf("Tasks");
    const computerUseIndex = content.indexOf("Computer Use");
    const browserIndex = content.indexOf("Browser");
    expect(tasksIndex >= 0).toBe(true);
    expect(computerUseIndex >= 0).toBe(true);
    expect(browserIndex >= 0).toBe(true);
    expect(tasksIndex < computerUseIndex).toBe(true);
    expect(computerUseIndex < browserIndex).toBe(true);

    const row = view.getByRole("button", { name: "Show PiP" });
    await expectTooltipContent(row, "Show PiP");
    expect(textContent(row).includes("Computer Use")).toBe(true);

    await clickAndAct(row);

    expect(JSON.stringify(toggles)).toBe(JSON.stringify([true]));
  });

  test("does not render the Computer Use PiP row without a toggle action", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={[]}
        computerUsePip={{ visible: true }}
        onErrorMessage={() => undefined}
      />,
    );

    expect(textContent(view.container).includes("Computer Use")).toBe(false);
  });

  test("renders browser rows with Codex-style URL, favicon, and working metadata", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={[]}
        browserRows={[
          {
            id: "browser-1",
            browserTabId: "browser-runtime-1",
            workbenchTabId: "browser-1",
            title: "Release notes",
            displayUrl: "example.com",
            url: "https://www.example.com/release-notes",
            faviconUrl: "https://www.example.com/favicon.ico",
            isAgentWorking: true,
            isMaterialized: true,
            panelId: "right",
            leafId: "leaf-browser",
          },
        ]}
        actions={
          {
            onOpenSummaryBrowserRow: () => undefined,
          } as Partial<ThreadStageActions> as ThreadStageActions
        }
        onErrorMessage={() => undefined}
      />,
    );

    const browserButton = view.getByRole("button", {
      name: "Release notes example.com",
    });
    await expectTooltipContent(
      browserButton,
      "Release notes\nhttps://www.example.com/release-notes",
    );
    expect(
      Boolean(view.container.querySelector('img[src="https://www.example.com/favicon.ico"]')),
    ).toBe(true);
    expect(Boolean(browserButton.querySelector(".loading-shimmer-pure-text"))).toBe(true);
    expect(Boolean(browserButton.querySelector('[data-browser-use-pointer="true"]'))).toBe(true);
    expect(textContent(view.container).includes("Right panel")).toBe(false);
  });

  test("opens a runtime-only Browser row by logical Browser identity", async () => {
    const opened: string[] = [];
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={[]}
        browserRows={[
          {
            id: "browser-use:runtime-only",
            browserTabId: "runtime-only",
            workbenchTabId: null,
            title: "Runtime page",
            displayUrl: "example.com",
            url: "https://example.com",
            faviconUrl: null,
            isAgentWorking: true,
            isMaterialized: false,
            leafId: null,
          },
        ]}
        actions={
          {
            onOpenSummaryBrowserRow: ({ browserTabId }) => {
              opened.push(browserTabId);
            },
          } as Partial<ThreadStageActions> as ThreadStageActions
        }
        onErrorMessage={() => undefined}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Runtime page example.com" }));
    });
    expect(opened).toEqual(["runtime-only"]);
  });

  test("renders the start-in row as a summary-panel dropdown trigger", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel !== "review-summary") return null;
      return makeSnapshot((input as { source: GitReviewSource }).source, 0, 0);
    };
    const actions = {
      onNewThreadStartInTargetChange: () => undefined,
    } as Partial<ThreadStageActions> as ThreadStageActions;

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
        actions={actions}
        newThreadStartInSelector={{
          target: {
            runInTarget: "localProject",
            runInEnvironmentPath: null,
          },
          disabled: false,
          worktreeAvailable: true,
          environments: [],
          environmentsLoading: false,
          environmentsError: false,
          selectedEnvironmentPath: null,
          defaultEnvironmentPath: null,
          environmentNeedsAttention: false,
          environmentRepairConfigPath: null,
        }}
        onErrorMessage={() => undefined}
      />,
    );

    const trigger = await waitFor(() => {
      const row = view.getByText("Local").closest("[role='button']");
      if (!(row instanceof HTMLElement)) throw new Error("Expected start-in trigger");
      return row;
    });
    expect(trigger.getAttribute("role")).toBe("button");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await expectTooltipContent(trigger, "Select where to run the task");
    expect(textContent(trigger).includes("Local")).toBe(true);

    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
    });

    await waitFor(() => {
      const menuText = view.container.ownerDocument.body.textContent ?? "";
      const localOption = view.container.ownerDocument.body.querySelector(
        '[data-new-chat-start-in-option="localProject"]',
      );
      expect(menuText.includes("Continue in")).toBe(true);
      expect(localOption?.textContent?.includes("Local") ?? false).toBe(true);
      expect(menuText.includes("New worktree")).toBe(true);
    });
  });

  test("renders the Sources section with the reference empty state", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={[]}
        onErrorMessage={() => undefined}
      />,
    );

    const content = textContent(view.container);
    expect(content.includes("Sources")).toBe(true);
    expect(content.includes("No sources yet")).toBe(true);
    expect(content.includes("Environment")).toBe(false);
    expect(view.container.querySelector('[aria-label="Sources"]') === null).toBe(true);
  });

  test("renders search-only sources as a non-openable icon", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const turns = [
      {
        items: [
          {
            itemId: "web-search",
            type: "webSearch",
            semanticKind: "webSearch",
            rawItem: {
              type: "webSearch",
              query: "Codex app-server",
              action: { type: "search", query: "Codex app-server" },
            },
          },
        ],
        status: "completed",
      },
    ] as unknown as CodexConversationTurn[];

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={turns}
        onErrorMessage={() => undefined}
      />,
    );

    expect(view.container.querySelector('button[aria-label="Web search"]') === null).toBe(true);
    expect(view.container.querySelector('[role="img"][aria-label="Web search"]') !== null).toBe(
      true,
    );
  });

  test("opens page sources externally", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const windowOpenCalls: unknown[][] = [];
    const originalWindowOpen = window.open;
    window.open = ((...args: unknown[]) => {
      windowOpenCalls.push(args);
      return null;
    }) as typeof window.open;

    try {
      const turns = [
        {
          items: [
            {
              itemId: "web-page",
              type: "webSearch",
              semanticKind: "webSearch",
              rawItem: {
                type: "webSearch",
                query: "Codex app-server",
                action: {
                  type: "openPage",
                  url: "https://www.example.com/docs",
                },
              },
            },
          ],
          status: "completed",
        },
      ] as unknown as CodexConversationTurn[];

      const view = renderSummary(
        <ThreadFloatingSummaryPanel
          mounted
          open
          activeThreadId="thread-1"
          cwd={null}
          projectWorkspacePath={null}
          turns={turns}
          onErrorMessage={() => undefined}
        />,
      );

      const sourceButton = view.container.querySelector(
        'button[aria-label="example.com/docs"]',
      ) as HTMLElement | null;
      expect(Boolean(sourceButton)).toBe(true);
      await clickAndAct(sourceButton as HTMLElement);

      expect(JSON.stringify(windowOpenCalls[0])).toBe(
        JSON.stringify(["https://www.example.com/docs", "_blank", "noopener,noreferrer"]),
      );
    } finally {
      window.open = originalWindowOpen;
    }
  });

  test("opens MCP app sources in the side panel when a renderable resource is already available", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const openCalls: unknown[] = [];
    const actions = {
      onOpenMcpAppSidePanel: async (input: unknown) => {
        openCalls.push(input);
      },
    } as Partial<ThreadStageActions> as ThreadStageActions;
    const turns = [
      {
        threadId: "thread-1",
        turnId: "turn-1",
        items: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "mcp-app",
            type: "mcpToolCall",
            semanticKind: "mcpToolCall",
            mcpToolCall: {
              callId: "call-1",
              functionName: "docs__search",
              pluginId: null,
              mcpAppResourceUri: undefined,
              source: null,
              invocation: {
                server: "docs",
                tool: "search",
                arguments: {},
              },
              result: {
                type: "success",
                content: [
                  {
                    type: "embedded_resource",
                    resource: {
                      uri: "ui://docs/search.html",
                      mimeType: "text/html;profile=mcp-app",
                      text: "<main>Docs app</main>",
                    },
                  },
                ],
                structuredContent: null,
                raw: {
                  content: [
                    {
                      type: "embedded_resource",
                      resource: {
                        uri: "ui://docs/search.html",
                        mimeType: "text/html;profile=mcp-app",
                        text: "<main>Docs app</main>",
                      },
                    },
                  ],
                  structuredContent: null,
                  _meta: { "openai/outputTemplate": "ui://docs/search.html" },
                },
              },
              durationMs: null,
              completed: true,
            },
          },
        ],
        status: "completed",
      },
    ] as unknown as CodexConversationTurn[];

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={turns}
        actions={actions}
        onErrorMessage={() => undefined}
      />,
    );

    const sourceButton = view.container.querySelector(
      'button[aria-label="Docs"]',
    ) as HTMLElement | null;
    expect(Boolean(sourceButton)).toBe(true);
    await clickAndAct(sourceButton as HTMLElement);

    const call = openCalls[0] as
      | {
          mcpAppId?: string;
          capabilityId?: string;
          resource?: unknown;
        }
      | undefined;
    expect(openCalls.length).toBe(1);
    expect(call?.mcpAppId).toBe("docs:ui://docs/search.html");
    expect(call?.capabilityId).toBe(
      "mcp-capability:thread-1:docs:search:call-1:ui%3A%2F%2Fdocs%2Fsearch.html",
    );
    expect(call?.resource).toBeUndefined();
  });

  test("resolves MCP app source resources before opening the side panel", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const openCalls: unknown[] = [];
    mockInvokeImpl = async (channel) => {
      if (channel === "codex:mcp-server-statuses:list") return { data: [], nextCursor: null };
      if (channel === "codex:mcp-resource:read") {
        return {
          contents: [
            {
              uri: "ui://docs/search.html",
              mimeType: "text/html;profile=mcp-app",
              text: "<main>Fetched Docs app</main>",
            },
          ],
        };
      }
      return null;
    };
    const actions = {
      onOpenMcpAppSidePanel: async (input: unknown) => {
        openCalls.push(input);
      },
    } as Partial<ThreadStageActions> as ThreadStageActions;
    const turns = [
      {
        threadId: "thread-1",
        turnId: "turn-1",
        items: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "mcp-app",
            type: "mcpToolCall",
            semanticKind: "mcpToolCall",
            mcpToolCall: {
              callId: "call-1",
              functionName: "docs__search",
              pluginId: null,
              mcpAppResourceUri: undefined,
              source: null,
              invocation: {
                server: "docs",
                tool: "search",
                arguments: {},
              },
              result: {
                type: "success",
                content: [],
                structuredContent: null,
                raw: {
                  content: [],
                  structuredContent: null,
                  _meta: { "openai/outputTemplate": "ui://docs/search.html" },
                },
              },
              durationMs: null,
              completed: true,
            },
          },
        ],
        status: "completed",
      },
    ] as unknown as CodexConversationTurn[];

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={turns}
        actions={actions}
        onErrorMessage={() => undefined}
      />,
    );

    await waitFor(() => {
      const sourceButton = view.container.querySelector('button[aria-label="Docs"]');
      if (!sourceButton) throw new Error("Expected resolved MCP source button");
    });

    const sourceButton = view.container.querySelector(
      'button[aria-label="Docs"]',
    ) as HTMLElement | null;
    await clickAndAct(sourceButton as HTMLElement);

    const call = openCalls[0] as
      | {
          mcpAppId?: string;
          capabilityId?: string;
          resource?: unknown;
        }
      | undefined;
    expect(openCalls.length).toBe(1);
    expect(call?.mcpAppId).toBe("docs:ui://docs/search.html");
    expect(call?.capabilityId).toBe(
      "mcp-capability:thread-1:docs:search:call-1:ui%3A%2F%2Fdocs%2Fsearch.html",
    );
    expect(call?.resource).toBeUndefined();
  });

  test("opens the summary panel plan row in the plan side panel", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const openCalls: unknown[] = [];
    const actions = {
      onOpenPlanInSidePanel: (input: ThreadPlanSidePanelTarget) => {
        openCalls.push(input);
      },
    } as Partial<ThreadStageActions> as ThreadStageActions;
    const turns = [
      {
        threadId: "thread-1",
        turnId: "turn-plan",
        items: [
          {
            threadId: "thread-1",
            turnId: "turn-plan",
            itemId: "plan-item",
            type: "plan",
            kind: "plan",
            semanticKind: "proposedPlan",
            status: "completed",
            role: "assistant",
            markdownText: "# Summary panel parity\n\nFull plan body",
            cwd: "/repo/project",
          },
        ],
        status: "completed",
      },
    ] as unknown as CodexConversationTurn[];

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={turns}
        actions={actions}
        onErrorMessage={() => undefined}
      />,
    );

    const row = view
      .getByText("Summary panel parity")
      .closest("[role='button']") as HTMLElement | null;
    expect(Boolean(row)).toBe(true);
    await clickAndAct(row as HTMLElement);

    const call = openCalls[0] as
      | {
          planKey?: string;
          threadId?: string;
          turnId?: string;
          itemId?: string;
          content?: string;
          cwd?: string | null;
          hideCodeBlocks?: boolean;
        }
      | undefined;
    expect(openCalls.length).toBe(1);
    expect(call?.planKey).toBe("turn-plan");
    expect(call?.threadId).toBe("thread-1");
    expect(call?.turnId).toBe("turn-plan");
    expect(call?.itemId).toBe("plan-item");
    expect(call?.content).toBe("# Summary panel parity\n\nFull plan body");
    expect(call?.cwd).toBe("/repo/project");
    expect(call?.hideCodeBlocks).toBe(false);
  });

  test("suppresses outputs when the active thread is in a git environment", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel !== "review-summary") return null;
      return makeSnapshot((input as { source: GitReviewSource }).source, 0, 0);
    };
    const turns = [
      {
        items: [
          {
            itemId: "generated-image",
            type: "imageGeneration",
            rawItem: {
              id: "generated-image",
              type: "imageGeneration",
              status: "completed",
              result: "",
              savedPath: "/repo/project/generated-one.png",
            },
          },
        ],
        status: "completed",
      },
    ] as unknown as CodexConversationTurn[];

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={turns}
        onErrorMessage={() => undefined}
      />,
    );

    await waitFor(() => {
      const queriedMethods = new Set(gitWorkerCalls.map((call) => call.method));
      if (
        !queriedMethods.has("stable-metadata") ||
        !queriedMethods.has("status-summary") ||
        !queriedMethods.has("branch-diff-stats")
      ) {
        throw new Error("Expected Git worker summary queries to load.");
      }
      expect(invokeCalls.some((call) => call[0] === "review-summary")).toBe(false);
      const content = textContent(view.container);
      expect(content.includes("Clean")).toBe(false);
      expect(content.includes("Outputs")).toBe(false);
      expect(content.includes("Generated image 1")).toBe(false);
    });
  });

  test("keeps outputs visible for projectless threads with a git cwd", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel !== "review-summary") return null;
      return makeSnapshot((input as { source: GitReviewSource }).source, 0, 0);
    };
    const turns = [
      {
        items: [
          {
            itemId: "generated-image",
            type: "imageGeneration",
            rawItem: {
              id: "generated-image",
              type: "imageGeneration",
              status: "completed",
              result: "",
              savedPath: "/repo/project/generated-one.png",
            },
          },
        ],
        status: "completed",
      },
    ] as unknown as CodexConversationTurn[];

    let renderedView = undefined as unknown as ReturnType<typeof renderSummary>;
    await act(async () => {
      renderedView = renderSummary(
        <ThreadFloatingSummaryPanel
          mounted
          open
          activeThreadId="thread-1"
          activeThreadProjectless
          cwd="/repo/project"
          projectWorkspacePath="/repo/project"
          turns={turns}
          onErrorMessage={() => undefined}
        />,
      );
    });

    await waitFor(() => {
      const queriedMethods = new Set(gitWorkerCalls.map((call) => call.method));
      if (
        !queriedMethods.has("stable-metadata") ||
        !queriedMethods.has("status-summary") ||
        !queriedMethods.has("branch-diff-stats")
      ) {
        throw new Error("Expected Git worker summary queries to load.");
      }
      expect(invokeCalls.some((call) => call[0] === "review-summary")).toBe(false);
      const content = textContent(renderedView.container);
      expect(content.includes("Environment")).toBe(false);
      expect(content.includes("Outputs")).toBe(true);
      expect(content.includes("Generated image 1")).toBe(true);
    });
  });

  test("opens generated image output rows in the image preview dialog", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const turns = [
      {
        items: [
          {
            itemId: "generated-image",
            type: "imageGeneration",
            rawItem: {
              id: "generated-image",
              type: "imageGeneration",
              status: "completed",
              result: "",
              savedPath: "/repo/project/generated-one.png",
            },
          },
        ],
        status: "completed",
      },
    ] as unknown as CodexConversationTurn[];

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={turns}
        onErrorMessage={() => undefined}
      />,
    );

    const outputRow = view
      .getByText("Generated image 1")
      .closest("[role='button']") as HTMLElement | null;
    expect(Boolean(outputRow)).toBe(true);
    await act(async () => {
      fireEvent.click(outputRow as HTMLElement);
    });

    const preview = await view.findByTestId("summary-image-preview");
    const previewImage = preview.querySelector("img");
    if (!(previewImage instanceof HTMLImageElement)) {
      throw new Error("expected generated image preview dialog");
    }
    expect(previewImage.alt).toBe("Generated image 1");
    expect(previewImage.src).toBe("app://fs/@fs/repo/project/generated-one.png");
    expect(invokeCalls.some((call) => call[0] === "shell:open-file-link")).toBe(false);
  });

  test("opens non-image summary panel output rows through the side panel opener first", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    mockInvokeImpl = async (channel: string) => channel === "shell:open-file-link";
    const openedOutputs: unknown[] = [];
    const actions = {
      onOpenSummaryOutputInSidePanel: async (target) => {
        openedOutputs.push(target);
        return true;
      },
    } as Partial<ThreadStageActions> as ThreadStageActions;
    const turns = [
      {
        items: [
          {
            itemId: "assistant",
            type: "agentMessage",
            markdownText: "Saved report at 【/repo/project/dist/report.txt†L1】.",
            rawItem: {
              id: "assistant",
              type: "agentMessage",
              text: "Saved report at 【/repo/project/dist/report.txt†L1】.",
            },
          },
        ],
        status: "completed",
      },
    ] as unknown as CodexConversationTurn[];

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={turns}
        actions={actions}
        onErrorMessage={() => undefined}
      />,
    );

    const outputRow = view.getByText("report.txt").closest("[role='button']") as HTMLElement | null;
    expect(Boolean(outputRow)).toBe(true);
    await act(async () => {
      fireEvent.click(outputRow as HTMLElement);
    });

    expect(JSON.stringify(openedOutputs)).toBe(
      JSON.stringify([
        {
          path: "/repo/project/dist/report.txt",
          title: "report.txt",
        },
      ]),
    );
    expect(invokeCalls.some((call) => call[0] === "shell:open-file-link")).toBe(false);
  });

  test("falls back to the desktop file opener when summary output side panel open is unavailable", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    mockInvokeImpl = async (channel: string) => channel === "shell:open-file-link";
    const actions = {
      onOpenSummaryOutputInSidePanel: async () => false,
    } as Partial<ThreadStageActions> as ThreadStageActions;
    const turns = [
      {
        items: [
          {
            itemId: "assistant",
            type: "agentMessage",
            markdownText: "Saved report at 【/repo/project/dist/report.txt†L1】.",
            rawItem: {
              id: "assistant",
              type: "agentMessage",
              text: "Saved report at 【/repo/project/dist/report.txt†L1】.",
            },
          },
        ],
        status: "completed",
      },
    ] as unknown as CodexConversationTurn[];

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={turns}
        actions={actions}
        onErrorMessage={() => undefined}
      />,
    );

    const outputRow = view.getByText("report.txt").closest("[role='button']") as HTMLElement | null;
    expect(Boolean(outputRow)).toBe(true);
    await act(async () => {
      fireEvent.click(outputRow as HTMLElement);
    });

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "shell:open-file-link" &&
          JSON.stringify(call).includes("/repo/project/dist/report.txt") &&
          JSON.stringify(call).includes("fileManager"),
      ),
    ).toBe(true);
  });

  test("opens URL summary panel output rows through the browser opener", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const originalOpen = window.open;
    const openedUrls: string[] = [];
    Object.defineProperty(window, "open", {
      configurable: true,
      value: (url?: string | URL) => {
        openedUrls.push(String(url ?? ""));
        return null;
      },
    });

    try {
      const driveUrl = "https://docs.google.com/document/d/doc-123/edit";
      const turns = [
        {
          items: [
            {
              itemId: "drive-tool",
              type: "mcpToolCall",
              mcpToolCall: {
                callId: "drive-tool",
                functionName: "google-drive__create_document",
                pluginId: null,
                mcpAppResourceUri: undefined,
                source: null,
                invocation: {
                  server: "google-drive",
                  tool: "create_document",
                  arguments: {},
                },
                result: {
                  type: "success",
                  content: [],
                  structuredContent: {
                    title: "Reference Roadmap",
                    document_url: driveUrl,
                  },
                  raw: {
                    content: [],
                    structuredContent: {
                      title: "Reference Roadmap",
                      document_url: driveUrl,
                    },
                    _meta: null,
                  },
                },
                durationMs: null,
                completed: true,
              },
            },
            {
              itemId: "assistant",
              type: "agentMessage",
              kind: "assistantMessage",
              semanticKind: "assistantMessage",
              markdownText: `Created [Draft](${driveUrl}).`,
            },
          ],
          status: "completed",
        },
      ] as unknown as CodexConversationTurn[];

      const view = renderSummary(
        <ThreadFloatingSummaryPanel
          mounted
          open
          activeThreadId="thread-1"
          cwd={null}
          projectWorkspacePath={null}
          turns={turns}
          onErrorMessage={() => undefined}
        />,
      );

      const outputRow = view
        .getByText("Reference Roadmap")
        .closest("[role='button']") as HTMLElement | null;
      expect(Boolean(outputRow)).toBe(true);
      await act(async () => {
        fireEvent.click(outputRow as HTMLElement);
      });

      await waitFor(() => {
        expect(openedUrls.join(",")).toBe(driveUrl);
      });
      expect(invokeCalls.some((call) => call[0] === "shell:open-file-link")).toBe(false);
    } finally {
      Object.defineProperty(window, "open", {
        configurable: true,
        value: originalOpen,
      });
    }
  });

  test("opens background subagent rows with subagent opener context", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const turns = [
      {
        turnId: "turn-parent",
        status: "inProgress",
        items: [
          {
            itemId: "agent",
            type: "collabAgentToolCall",
            status: "completed",
            rawItem: {
              tool: "spawnAgent",
              status: "completed",
              receiverThreadIds: ["child-1"],
              receiverThreads: [
                {
                  threadId: "child-1",
                  thread: {
                    nickname: "Scout",
                    model: "gpt-5.3-codex",
                    agentRole: "explorer",
                  },
                },
              ],
              agentsStates: {
                "child-1": {
                  status: "running",
                  message: null,
                },
              },
              model: "gpt-5.3-codex",
            },
          },
        ],
      },
    ] as unknown as CodexConversationTurn[];
    const openCalls: unknown[] = [];
    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={turns}
        childMemberships={[makeSubagentMembership({ displayName: "@Scout" })]}
        knownConversationsById={{
          "child-1": makeSubagentConversation({
            turns: [
              {
                turnId: "child-turn",
                status: "inProgress",
                diff: "@@ -1 +1,2 @@\n-old\n+new\n+another",
                items: [
                  {
                    itemId: "reasoning",
                    type: "reasoning",
                    semanticKind: "reasoning",
                    markdownText: "**Checking files.**",
                    rawItem: {
                      summary: [{ text: "**Checking files.**" }],
                    },
                  },
                ],
              },
            ] as unknown as CodexConversationTurn[],
          }),
        }}
        onOpenThread={(threadId, context) => {
          openCalls.push({ threadId, context });
        }}
        onErrorMessage={() => undefined}
      />,
    );

    const row = view.getByText("Scout").closest("[role='button']") as HTMLElement | null;
    expect(Boolean(row)).toBe(true);
    await clickAndAct(row as HTMLElement);

    const call = openCalls[0] as
      | {
          threadId?: string;
          context?: {
            subagent?: {
              conversationId?: string;
              displayName?: string;
              agentRole?: string | null;
              showInlineActivity?: boolean;
              spawnModel?: string | null;
              status?: string;
              statusSummary?: string | null;
              diffStats?: { linesAdded?: number; linesRemoved?: number } | null;
            };
          };
        }
      | undefined;
    expect(openCalls.length).toBe(1);
    expect(call?.threadId).toBe("child-1");
    expect(call?.context?.subagent?.conversationId).toBe("child-1");
    expect(call?.context?.subagent?.displayName).toBe("Scout");
    expect(call?.context?.subagent?.agentRole).toBe("explorer");
    expect(call?.context?.subagent?.spawnModel).toBe("gpt-5.3-codex");
    expect(call?.context?.subagent?.status).toBe("active");
    expect(call?.context?.subagent?.statusSummary).toBe("checking files");
    expect(
      `${call?.context?.subagent?.diffStats?.linesAdded ?? -1}:${call?.context?.subagent?.diffStats?.linesRemoved ?? -1}`,
    ).toBe("2:1");
  });

  test("renders inline subagents as compact strip and lists only non-inline rows", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const openCalls: unknown[] = [];
    const openPanelCalls: string[] = [];
    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={[]}
        childMemberships={[
          makeSubagentMembership({
            threadId: "inline-active",
            displayName: "Inline active",
            showInlineActivity: true,
          }),
          makeSubagentMembership({
            threadId: "inline-waiting",
            displayName: "Inline waiting",
            showInlineActivity: true,
          }),
          makeSubagentMembership({
            threadId: "inline-done",
            displayName: "Inline done",
            showInlineActivity: true,
          }),
          makeSubagentMembership({
            threadId: "listed-active",
            displayName: "Listed active",
            showInlineActivity: false,
          }),
          makeSubagentMembership({
            threadId: "listed-waiting",
            displayName: "Listed waiting",
            showInlineActivity: false,
          }),
        ]}
        knownConversationsById={{
          "inline-active": makeSubagentConversation({
            threadId: "inline-active",
            statusType: "active",
            threadName: "Inline active",
            agentNickname: "Inline active",
          }),
          "inline-waiting": makeSubagentConversation({
            threadId: "inline-waiting",
            statusType: "notLoaded",
            threadName: "Inline waiting",
            agentNickname: "Inline waiting",
          }),
          "inline-done": makeSubagentConversation({
            threadId: "inline-done",
            statusType: "idle",
            threadName: "Inline done",
            agentNickname: "Inline done",
          }),
          "listed-active": makeSubagentConversation({
            threadId: "listed-active",
            statusType: "active",
            threadName: "Listed active",
            agentNickname: "Listed active",
            turns: [
              {
                turnId: "listed-active-turn",
                status: "inProgress",
                diff: "@@ -1 +1,2 @@\n-old\n+new\n+another",
                items: [],
              },
            ] as unknown as CodexConversationTurn[],
          }),
          "listed-waiting": makeSubagentConversation({
            threadId: "listed-waiting",
            statusType: "notLoaded",
            threadName: "Listed waiting",
            agentNickname: "Listed waiting",
          }),
        }}
        onOpenThread={(threadId, context) => {
          openCalls.push({ threadId, context });
        }}
        actions={{
          onOpenSubagentsPanel: () => {
            openPanelCalls.push("open");
          },
        }}
        onErrorMessage={() => undefined}
      />,
    );

    const content = textContent(view.container);
    expect(Boolean(content.includes("Subagents"))).toBe(true);
    expect(Boolean(content.includes("1 working"))).toBe(true);
    expect(Boolean(content.includes("2 done"))).toBe(true);
    expect(Boolean(content.includes("Listed active"))).toBe(true);
    expect(Boolean(content.includes("Listed waiting"))).toBe(true);
    expect(Boolean(content.includes("is working"))).toBe(true);
    expect(Boolean(content.includes("Waiting"))).toBe(false);
    expect(Boolean(content.includes("Done"))).toBe(false);
    expect(Boolean(content.includes("+2"))).toBe(true);
    expect(Boolean(content.includes("-1"))).toBe(true);
    expect(
      view.container.querySelector('[data-subagent-avatar-seed="inline-active"]') !== null,
    ).toBe(true);
    expect(
      view.container.querySelector('[data-subagent-avatar-seed="inline-waiting"]') === null,
    ).toBe(true);
    expect(view.container.querySelector('[data-subagent-avatar-seed="inline-done"]') === null).toBe(
      true,
    );
    expect(
      view.container.querySelector('[data-subagent-avatar-seed="listed-active"]') !== null,
    ).toBe(true);

    await clickAndAct(view.getByRole("button", { name: "Open subagents" }));
    expect(openPanelCalls).toEqual(["open"]);

    await clickAndAct(view.getByRole("button", { name: /Listed active/ }));
    const call = openCalls[0] as
      | {
          threadId?: string;
          context?: {
            subagent?: {
              conversationId?: string;
              showInlineActivity?: boolean;
            };
          };
        }
      | undefined;
    expect(call?.threadId).toBe("listed-active");
    expect(call?.context?.subagent?.conversationId).toBe("listed-active");
    expect(call?.context?.subagent?.showInlineActivity).toBe(false);
  });

  test("uses the first four done inline subagents when no inline subagent is working", async () => {
    const { ThreadFloatingSummaryPanel } = await import("./thread-floating-summary-panel");
    const memberships = [1, 2, 3, 4, 5].map((index) =>
      makeSubagentMembership({
        threadId: `done-inline-${index}`,
        displayName: `Done inline ${index}`,
        showInlineActivity: true,
      }),
    );
    const knownConversationsById = Object.fromEntries(
      memberships.map((membership, index) => [
        membership.threadId,
        makeSubagentConversation({
          threadId: membership.threadId,
          statusType: "idle",
          threadName: `Done inline ${index + 1}`,
          agentNickname: `Done inline ${index + 1}`,
        }),
      ]),
    );

    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd={null}
        projectWorkspacePath={null}
        turns={[]}
        childMemberships={memberships}
        knownConversationsById={knownConversationsById}
        onErrorMessage={() => undefined}
      />,
    );

    const content = textContent(view.container);
    expect(Boolean(content.includes("5 done"))).toBe(true);
    expect(
      view.container.querySelector('[data-subagent-avatar-seed="done-inline-1"]') !== null,
    ).toBe(true);
    expect(
      view.container.querySelector('[data-subagent-avatar-seed="done-inline-2"]') !== null,
    ).toBe(true);
    expect(
      view.container.querySelector('[data-subagent-avatar-seed="done-inline-5"]') === null,
    ).toBe(true);
  });
});
