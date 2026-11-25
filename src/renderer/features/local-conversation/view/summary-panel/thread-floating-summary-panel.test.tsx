import { toast } from "@/components/ui/toast";
// Collect the fixed component graph before a test owns its render and cleanup lifetime.
import { ThreadFloatingSummaryPanel } from "./thread-floating-summary-panel";
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
  CodexConversationTurn,
  GitActionStatusResult,
  GitReviewSnapshot,
  GitReviewSource,
} from "../../../../lib/types";
import { NodexTooltipProvider } from "../../../../components/ui/tooltip";
import { buildReviewFileSafety } from "../../../../../shared/review-file-safety";
import { textContent } from "../../../../test/dom";
import { renderWithAppMaitai as render } from "../../../../test/app-maitai";
import { TestQueryProvider } from "../../../../test/query";
import type { ThreadStageActions } from "../../thread-stage-types";
import { projectNativeTaskRows } from "../../native-task-presentation";
import { buildThreadHandoffOperation } from "../../../../test/thread-handoff-fixture";

const outputOpeners = vi.hoisted(() => ({
  openFile: vi.fn(),
  openDefault: vi.fn(),
  openLink: vi.fn(),
}));
vi.mock("@/lib/link-opening", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/link-opening")>()),
  openLink: outputOpeners.openLink,
}));
vi.mock("@/lib/file-reference-router", () => ({
  useFileReferenceRouter: () => ({ open: outputOpeners.openFile }),
}));
vi.mock("@/lib/file-system-operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/file-system-operations")>()),
  openPathWithDefaultApplication: outputOpeners.openDefault,
}));

let invokeCalls: [channel: string, ...args: unknown[]][] = [];
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
  if (channel === "workspace-path-states") {
    return {
      states: (args[0] as { paths: string[] }).paths.map((path) => ({
        path,
        exists: true,
        isGitSourcePath: true,
      })),
    };
  }
  if (mockInvokeImpl) {
    const result = await mockInvokeImpl(channel, ...args);
    if (channel === "codex:app-server:request" && result == null) {
      return { type: "result", result: undefined };
    }
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
  if (channel === "codex:app-server:request") {
    return { type: "result", result: undefined };
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
  subscribeCodexThreadHandoffsChanged: () => () => undefined,
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

function makeFileOutputTurns(path: string): CodexConversationTurn[] {
  const text = `:codex-file-citation{path="${path}"}`;
  return [
    {
      items: [
        {
          itemId: "assistant",
          type: "agentMessage",
          markdownText: text,
          rawItem: { id: "assistant", type: "agentMessage", text },
        },
      ],
      status: "completed",
    },
  ] as unknown as CodexConversationTurn[];
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

describe("ThreadFloatingSummaryPanel", () => {
  beforeAll(() => {
    summaryPanelPendingDefaultsEnabled = true;
  });

  beforeEach(() => {
    vi.mocked(toast.danger).mockClear();
    invokeCalls = [];
    gitWorkerCalls = [];
    mockInvokeImpl = null;
    outputOpeners.openFile.mockReset().mockResolvedValue(true);
    outputOpeners.openDefault.mockReset().mockResolvedValue(true);
    outputOpeners.openLink.mockReset().mockResolvedValue(true);
    Object.defineProperty(window, "api", {
      configurable: true,
      value: { invoke: invokeForTest, on: () => () => undefined },
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

  test("a closed summary retains its surface without reading repository or app data", async () => {
    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open={false}
        activeThreadId="thread-1"
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const outer = view.container.querySelector('[data-thread-summary-panel-open="false"]');
    expect(outer?.hasAttribute("inert")).toBe(true);
    expect(gitWorkerCalls).toEqual([]);
    expect(invokeCalls.filter(([channel]) => pendingByDefaultInvokeChannels.has(channel))).toEqual(
      [],
    );
  });

  test("creates a branch before opening the detached commit workflow", async () => {
    const branchCreateInputs: unknown[] = [];
    let branchCreated = false;
    const readStatus = (): GitActionStatusResult => ({
      cwd: "/repo/project",
      isGitRepository: true,
      currentBranch: branchCreated ? "nodex/detached-fix" : null,
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
          currentBranch: branchCreated ? "nodex/detached-fix" : null,
          defaultBranch: "main",
          branches: branchCreated ? ["nodex/detached-fix", "main"] : ["main"],
          errorMessage: null,
        };
      }

      if (channel === "create-branch") {
        branchCreateInputs.push(input);
        if (branchCreateInputs.length === 1) return new Error("Branch name is already in use");
        branchCreated = true;
        return {
          cwd: "/repo/project",
          currentBranch: "nodex/detached-fix",
          defaultBranch: "main",
          branches: ["nodex/detached-fix", "main"],
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
      branchNameInput.value = "nodex/detached-fix";
      fireEvent.input(branchNameInput);
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Create" }));
    });

    expect(await view.findByText("Branch name is already in use")).toBeTruthy();
    expect(toast.danger).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Create" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      if (branchCreateInputs.length !== 2) {
        throw new Error("Expected branch creation before commit workflow.");
      }
    });

    expect(JSON.stringify(branchCreateInputs[0])).toBe(
      JSON.stringify({
        cwd: "/repo/project",
        branch: "nodex/detached-fix",
      }),
    );

    await waitFor(() => {
      if (!view.getByLabelText("Commit message")) {
        throw new Error("Expected commit workflow dialog after branch setup.");
      }
    });
  });

  test("creates a branch before opening the managed default-branch push workflow", async () => {
    const branchCreateInputs: unknown[] = [];
    let branchCreated = false;
    const readStatus = (): GitActionStatusResult => ({
      cwd: "/repo/project",
      isGitRepository: true,
      currentBranch: branchCreated ? "nodex/default-worktree" : "main",
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
          currentBranch: branchCreated ? "nodex/default-worktree" : "main",
          defaultBranch: "main",
          branches: branchCreated ? ["main", "nodex/default-worktree"] : ["main"],
          errorMessage: null,
        };
      }

      if (channel === "create-branch") {
        branchCreateInputs.push(input);
        branchCreated = true;
        return {
          cwd: "/repo/project",
          currentBranch: "nodex/default-worktree",
          defaultBranch: "main",
          branches: ["main", "nodex/default-worktree"],
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
      branchNameInput.value = "nodex/default-worktree";
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
        branch: "nodex/default-worktree",
      }),
    );

    await waitFor(() => {
      if (
        !textContent(view.baseElement).includes("Push nodex/default-worktree and set upstream.")
      ) {
        throw new Error("Expected push workflow dialog after branch setup.");
      }
      expect(Boolean(view.getByRole("button", { name: "Push" }))).toBe(true);
    });
  });

  test("shows generated-message and commit phases for blank commit messages", async () => {
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

  test("creates a branch before opening the managed default-branch create-pr workflow", async () => {
    const branchCreateInputs: unknown[] = [];
    let branchCreated = false;
    const readStatus = (): GitActionStatusResult => ({
      cwd: "/repo/project",
      isGitRepository: true,
      currentBranch: branchCreated ? "nodex/default-pr-worktree" : "main",
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
          currentBranch: branchCreated ? "nodex/default-pr-worktree" : "main",
          defaultBranch: "main",
          branches: branchCreated ? ["main", "nodex/default-pr-worktree"] : ["main"],
          errorMessage: null,
        };
      }

      if (channel === "create-branch") {
        branchCreateInputs.push(input);
        branchCreated = true;
        return {
          cwd: "/repo/project",
          currentBranch: "nodex/default-pr-worktree",
          defaultBranch: "main",
          branches: ["main", "nodex/default-pr-worktree"],
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
      branchNameInput.value = "nodex/default-pr-worktree";
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
        branch: "nodex/default-pr-worktree",
      }),
    );
  });

  test("lists closed side chats past the first four and reads older ones on demand", async () => {
    const opened: (string | null)[] = [];
    let loadMoreCount = 0;
    const actions = {
      onOpenSummarySideChatRow: (input: { rowId: string; panelId: string | null }) => {
        opened.push(input.panelId);
      },
      onLoadMoreSummarySideChats: () => {
        loadMoreCount += 1;
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
        sideChatRows={Array.from({ length: 6 }, (_, index) => ({
          id: `sidechat-session:${index}`,
          title: `Question ${index + 1}`,
          isResponseInProgress: false,
        }))}
        actions={actions}
      />,
    );

    expect(view.queryByRole("button", { name: "Question 5" })).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Show more" }));
      await Promise.resolve();
    });
    fireEvent.click(view.getByRole("button", { name: "Question 6" }));
    expect(opened).toEqual([null]);
    fireEvent.click(view.getByRole("button", { name: "Show more" }));
    expect(loadMoreCount).toBe(1);
  });

  test("opens a runtime-only Browser row by logical Browser identity", async () => {
    const opened: string[] = [];
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
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Runtime page example.com" }));
    });
    expect(opened).toEqual(["runtime-only"]);
  });

  test("keeps a chat whose worktree is gone movable without its Git rows", async () => {
    mockInvokeImpl = async (channel: string, input?: unknown) => {
      if (channel === "codex:thread-handoffs:list") return { revision: 0, operations: [] };
      // Git finds no repository where the worktree used to be.
      if (channel === "review-summary")
        return {
          ...makeSnapshot((input as { source: GitReviewSource }).source, 0, 0),
          isGitRepository: false,
        };
      return null;
    };
    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd="/managed/ab12/project"
        projectWorkspacePath="/repo/project"
        turns={[]}
        activeThreadIsManagedWorktree
        executionLocation={{
          threadId: "thread-1",
          kind: "worktree",
          canMove: true,
          source: "gone",
        }}
      />,
    );
    // Once Git finds no repository at the missing folder, only where the chat runs remains.
    await waitFor(() => expect(view.queryByText("Changes")).toBeNull());
    expect(view.getByText("Environment")).toBeTruthy();
    const trigger = view.getByText("Worktree").closest("[role='button']");
    expect(trigger?.getAttribute("aria-haspopup")).toBe("menu");
  });

  for (const kind of ["local", "worktree"] as const) {
    test(`moves the attached ${kind} chat through its execution owner`, async () => {
      mockInvokeImpl = async (channel: string, input?: unknown) => {
        if (channel === "codex:thread-handoffs:list") return { revision: 0, operations: [] };
        if (channel === "branch-metadata")
          return {
            currentBranch: "feature/summary-panel",
            defaultBranch: "main",
            branches: ["main", "feature/summary-panel"],
          };
        if (channel === "thread-execution:handoff")
          return buildThreadHandoffOperation({
            operationId: (input as { operationId: string }).operationId,
            threadId: "thread-1",
            sourceThreadId: "thread-1",
            requestThreadId: "thread-1",
          });
        if (channel !== "review-summary") return null;
        return makeSnapshot((input as { source: GitReviewSource }).source, 0, 0);
      };
      const view = renderSummary(
        <ThreadFloatingSummaryPanel
          mounted
          open
          activeThreadId="thread-1"
          cwd="/repo/project"
          projectWorkspacePath="/repo/project"
          turns={[]}
          activeThreadIsManagedWorktree={kind === "worktree"}
          executionLocation={{ threadId: "thread-1", kind, canMove: true, source: "present" }}
        />,
      );

      const trigger = await waitFor(() => {
        const row = view
          .getByText(kind === "local" ? "Local" : "Worktree")
          .closest("[role='button']");
        if (!(row instanceof HTMLElement)) throw new Error("Expected execution-location trigger");
        return row;
      });
      expect(trigger.getAttribute("role")).toBe("button");
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      await expectTooltipContent(trigger, "Select where to run the task");
      await act(async () => {
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
        fireEvent.click(trigger);
      });

      const destination = kind === "local" ? "worktree" : "local";
      const option = await view.findByRole("menuitem", {
        name: destination === "worktree" ? "Worktree" : "Local",
      });
      await act(async () => {
        fireEvent.click(option);
        await Promise.resolve();
      });
      const moveButton = await view.findByRole("button", {
        name: destination === "worktree" ? "Move to worktree" : "Move to local",
      });
      expect(invokeCalls.filter(([channel]) => channel === "thread-execution:handoff")).toEqual([]);
      await act(async () => {
        fireEvent.click(moveButton);
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(invokeCalls.filter(([channel]) => channel === "thread-execution:handoff")).toEqual([
          [
            "thread-execution:handoff",
            {
              threadId: "thread-1",
              operationId: expect.any(String),
              destination,
              expectedSource: "present",
            },
          ],
        ]),
      );
      expect(trigger.getAttribute("aria-disabled")).toBe("true");
      expect(textContent(trigger)).toBe(kind === "local" ? "Local" : "Worktree");
    });
  }

  test("resolves MCP app source resources before opening the side panel", async () => {
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

  test("hands a local HTML summary output to the file router, never the default application", async () => {
    const path = "/repo/project/dist/report.html";
    const view = renderSummary(
      <ThreadFloatingSummaryPanel
        mounted
        open
        activeThreadId="thread-1"
        cwd="/repo/project"
        projectWorkspacePath="/repo/project"
        turns={makeFileOutputTurns(path)}
      />,
    );

    const row = await view.findByRole("button", { name: "report.html" });
    await clickAndAct(row);

    await waitFor(() =>
      expect(outputOpeners.openFile).toHaveBeenCalledWith(
        { path },
        expect.objectContaining({ sidePanel: true, title: "report.html" }),
      ),
    );
    expect(outputOpeners.openDefault).not.toHaveBeenCalled();
  });

  for (const projectless of [false, true]) {
    test(`native task rows select observations without Thread navigation (projectless=${projectless})`, async () => {
      const membership = makeSubagentMembership({
        threadId: "agent-task:thread-1:review",
        displayName: "Review changes",
        task: {
          id: "review",
          description: "Review changes",
          bornTurnSequence: 1,
          status: "completed",
        },
      });
      const backgroundAgentRows = projectNativeTaskRows([membership], () => null);
      const onOpenThread = vi.fn();
      const onOpenTaskObservation = vi.fn();
      const view = renderSummary(
        <ThreadFloatingSummaryPanel
          mounted
          open
          activeThreadId="thread-1"
          activeThreadProjectless={projectless}
          cwd={null}
          projectWorkspacePath={null}
          turns={[]}
          backgroundAgentRows={backgroundAgentRows}
          taskDetailsKind="observation"
          actions={{ onOpenTaskObservation }}
          onOpenThread={onOpenThread}
        />,
      );
      const row = view.getByText("Review changes").closest("[role='button']");
      if (!row) throw new Error("Expected selectable task observation");
      await clickAndAct(row);
      expect(onOpenTaskObservation).toHaveBeenCalledExactlyOnceWith("agent-task:thread-1:review");
      expect(onOpenThread).not.toHaveBeenCalled();
    });
  }
});

vi.mock("@/components/ui/toast", () => ({
  toast: { danger: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
