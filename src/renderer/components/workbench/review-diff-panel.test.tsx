import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createElement, useEffect, useRef, type ComponentProps } from "react";
import { act, fireEvent, type RenderResult, waitFor } from "@testing-library/react";
import { renderWithMaitai as render } from "../../test/thread-maitai";
import { textContent } from "../../test/dom";
import { TestQueryProvider } from "../../test/query";
import { __resetNodexToastStoreForTests } from "../ui/toast";
import { NodexTooltipProvider } from "../ui/tooltip";
import {
  FileReferenceHostProvider,
  FileReferenceRouterProvider,
} from "@/lib/file-reference-router";
import { FileLinkOpenerProvider } from "@/lib/use-file-link-opener";
import { FILE_LINK_OPENER_STORAGE_KEY } from "@/lib/file-link-opener-settings";
import type { CodexConversationSnapshot, GitReviewLiveEvent } from "@/lib/types";
import { buildReviewFileSafety } from "../../../shared/review-file-safety";
import { ReviewDiffPanel } from "./review-diff-panel";
import { parsePatchFiles } from "@pierre/diffs";
import { __resetReviewFullContentStoreForTests } from "@/features/review/data/review-full-content-store";
import { __resetReviewCatFileBatcherForTests } from "@/features/review/data/review-cat-file-batcher";
import { __resetReviewDiffBatcherForTests } from "@/features/review/data/review-diff-batcher";
import { __resetReviewDiffCommentAttachmentStoreForTests } from "@/lib/review-diff-comment-attachment-store";
import {
  buildReviewConversationProjection,
  type ReviewConversationProjection,
} from "@/features/review/model/review-conversation-projection";
import type { FileDiffMetadata, FileDiffProps } from "@pierre/diffs/react";
import { useSetScopedAtom } from "@/lib/maitai";
import {
  prepareReviewOpenAtom,
  type ReviewOpenIntent,
} from "@/features/review/model/review-view-state";
import type { GitWorkerQueryClient } from "@/features/review/data/git-query";

const menuPorts = vi.hoisted(() => ({
  readTargets: vi.fn(),
  openTarget: vi.fn(),
  showMenu: vi.fn(),
  openUrl: vi.fn(),
  github: vi.fn(),
}));
vi.mock("@/lib/file-reference-open-targets", () => ({
  readFileReferenceOpenTargets: menuPorts.readTargets,
  openFileReferenceTarget: menuPorts.openTarget,
}));
vi.mock("@/lib/link-opening", () => ({ openLink: menuPorts.openUrl }));
vi.mock("@/lib/native-context-menu", () => ({ showNativeContextMenu: menuPorts.showMenu }));
vi.mock("@/lib/workspace-file-operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-file-operations")>()),
  readWorkspaceFileGitHubUrl: menuPorts.github,
}));
vi.mock("@/lib/file-system-operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/file-system-operations")>()),
  openExternalUrl: menuPorts.openUrl,
}));

const invokeCalls: unknown[][] = [];
const startThreadPromptCalls: Array<{ threadId: string; prompt: string }> = [];
const clipboardWrites: string[] = [];
let mockInvokeImpl: ((...args: unknown[]) => Promise<unknown>) | null = null;
let lastFileDiffProps: FileDiffProps<unknown, undefined> | null = null;
const openWorkspaceFileTab = vi.fn(async () => true);

function PrepareReviewOpen({ intent }: { readonly intent: ReviewOpenIntent }) {
  const prepareOpen = useSetScopedAtom(prepareReviewOpenAtom);
  const intentRef = useRef(intent);
  useEffect(() => {
    prepareOpen(intentRef.current);
  }, [prepareOpen]);
  return null;
}

function installControlledIntersectionObserver() {
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  const observed = new Map<
    Element,
    {
      callback: IntersectionObserverCallback;
      observer: IntersectionObserver;
    }
  >();

  class ControlledIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly scrollMargin = "0px";
    readonly thresholds = [0];

    constructor(private readonly callback: IntersectionObserverCallback) {}

    disconnect(): void {
      for (const [target, record] of observed) {
        if (record.observer === this) observed.delete(target);
      }
    }

    observe(target: Element): void {
      observed.set(target, { callback: this.callback, observer: this });
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }

    unobserve(target: Element): void {
      if (observed.get(target)?.observer === this) observed.delete(target);
    }
  }

  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: ControlledIntersectionObserver,
  });

  return {
    isObserved(target: Element): boolean {
      return observed.has(target);
    },
    emit(target: Element): void {
      const record = observed.get(target);
      if (!record) throw new Error("Expected target to be observed.");
      record.callback(
        [
          {
            target,
            isIntersecting: true,
            intersectionRatio: 1,
          } as IntersectionObserverEntry,
        ],
        record.observer,
      );
    },
    restore(): void {
      Object.defineProperty(globalThis, "IntersectionObserver", {
        configurable: true,
        writable: true,
        value: originalIntersectionObserver,
      });
    },
  };
}

async function recordStartThreadPrompt(threadId: string, prompt: string): Promise<void> {
  startThreadPromptCalls.push({ threadId, prompt });
}

function stripPatchPath(value: string): string {
  return value.replace(/^([ab])\//, "");
}

function isDomElement(value: unknown): value is HTMLElement {
  return (
    typeof value === "object" &&
    value !== null &&
    "nodeType" in value &&
    (value as { nodeType?: unknown }).nodeType === Node.ELEMENT_NODE
  );
}

function parsePatchFilesForTest(patch: string): Array<{ files: FileDiffMetadata[] }> {
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return [];

  const filePatches = normalizedPatch
    .split(/^diff --git /m)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => `diff --git ${chunk}`);

  return filePatches.map((filePatch) => {
    const lines = filePatch.split("\n");
    const previousHeader = lines.find((line) => line.startsWith("--- ")) ?? null;
    const nextHeader = lines.find((line) => line.startsWith("+++ ")) ?? null;
    const previousPath = previousHeader
      ? stripPatchPath(
          previousHeader
            .slice(4)
            .trim()
            .replace(/^\/dev\/null$/, ""),
        )
      : "";
    const nextPath = nextHeader
      ? stripPatchPath(
          nextHeader
            .slice(4)
            .trim()
            .replace(/^\/dev\/null$/, ""),
        )
      : "";

    const hunks = lines.reduce<
      Array<{
        header: string;
        additionStart: number;
        deletionStart: number;
        additionLines: number;
        deletionLines: number;
      }>
    >((acc, line) => {
      if (!line.startsWith("@@ ")) return acc;
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      acc.push({
        header: line,
        deletionStart: Number(match?.[1] ?? "1"),
        additionStart: Number(match?.[2] ?? "1"),
        additionLines: 0,
        deletionLines: 0,
      });
      return acc;
    }, []);

    let currentHunk = hunks[0] ?? null;
    let hunkIndex = 0;
    for (const line of lines) {
      if (line.startsWith("@@ ")) {
        currentHunk = hunks[hunkIndex] ?? null;
        hunkIndex += 1;
        continue;
      }
      if (!currentHunk) continue;
      if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
      if (line.startsWith("+")) {
        currentHunk.additionLines += 1;
        continue;
      }
      if (line.startsWith("-")) {
        currentHunk.deletionLines += 1;
      }
    }

    const fileDiff =
      parsePatchFiles(filePatch).flatMap((parsed) => parsed.files)[0] ??
      ({
        name: nextPath || previousPath || "file.ts",
        prevName: previousPath || null,
        type: previousPath.length === 0 ? "add" : nextPath.length === 0 ? "delete" : "modify",
        hunks,
        additionLines: hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0),
        deletionLines: hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0),
      } as unknown as FileDiffMetadata);

    return { files: [fileDiff] };
  });
}

function parseAddedPatchFileWithLineArraysForTest(): Array<{
  files: FileDiffMetadata[];
}> {
  return [
    {
      files: [
        {
          name: "src/created.ts",
          prevName: null,
          type: "add",
          hunks: [
            {
              header: "@@ -0,0 +1,2 @@",
              deletionStart: 0,
              deletionCount: 0,
              deletionLines: 0,
              deletionLineIndex: 0,
              additionStart: 1,
              additionCount: 2,
              additionLines: 2,
              additionLineIndex: 0,
            },
          ],
          additionLines: ["export const created = true;\n", 'export const source = "patch";\n'],
          deletionLines: [],
        } as unknown as FileDiffMetadata,
      ],
    },
  ];
}

function countTestFileDiffLines(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return String(value.length);
  return "";
}

function testDiffOptionValue(options: unknown, key: string): string {
  if (typeof options !== "object" || options === null) return "";
  const value = (options as Record<string, unknown>)[key];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

const reviewDiffPanelTestInvoke = async (...args: unknown[]) => {
  invokeCalls.push(args);
  if (!mockInvokeImpl) return null;
  const result = await mockInvokeImpl(...args);
  if (result !== null) {
    if (args[0] !== "review-diff" || typeof result !== "object" || result === null) {
      return result;
    }
    const diffResult = result as {
      cwd?: string;
      source?: "unstaged" | "staged" | "branch" | "commit";
      patch?: string;
      files?: ReturnType<typeof buildGitSummary>[];
    };
    if (
      typeof diffResult.patch !== "string" ||
      diffResult.files?.some((file) => "diff" in file) === true
    ) {
      return result;
    }
    return buildGitDiffResultForTest({
      cwd: diffResult.cwd,
      source: diffResult.source,
      patch: diffResult.patch,
      files: diffResult.files,
    });
  }

  if (args[0] !== "review-summary") {
    return result;
  }
  const legacyResult = await mockInvokeImpl("review-diff", args[1]);
  if (typeof legacyResult !== "object" || legacyResult === null) return result;

  const legacySnapshot = legacyResult as {
    cwd?: string;
    source?: "unstaged" | "staged" | "branch" | "commit";
    patch?: string;
    files?: ReturnType<typeof buildGitSummary>[];
    isGitRepository?: boolean;
    baseRef?: string | null;
    currentBranch?: string | null;
    defaultBranch?: string | null;
    errorMessage?: string | null;
  };
  return {
    cwd: legacySnapshot.cwd ?? "/tmp/codex",
    source: legacySnapshot.source ?? "unstaged",
    patch: "",
    files:
      legacySnapshot.files && legacySnapshot.files.length > 0
        ? legacySnapshot.files
        : buildGitSummariesFromPatch(legacySnapshot.patch ?? ""),
    isGitRepository: legacySnapshot.isGitRepository ?? true,
    baseRef: legacySnapshot.baseRef ?? null,
    currentBranch: legacySnapshot.currentBranch ?? "feature",
    defaultBranch: legacySnapshot.defaultBranch ?? "main",
    errorMessage: legacySnapshot.errorMessage ?? null,
    snapshotGeneration: 1,
    additions: 0,
    deletions: 0,
    stageCounts: {
      stagedFileCount: 0,
      unstagedFileCount: 0,
      untrackedFileCount: 0,
    },
  };
};

function createReviewGitWorkerTestClient(): GitWorkerQueryClient {
  return {
    request: async (input) => {
      switch (input.method) {
        case "stable-metadata": {
          const params = input.params as { cwd: string };
          const result = await reviewDiffPanelTestInvoke("stable-metadata", input.params);
          if (typeof result === "object" && result !== null && "cwd" in result) {
            const metadata = result as Record<string, unknown> & { cwd: string };
            if (metadata.isGitRepository === false) return result as never;
            return {
              ...metadata,
              root: metadata.root ?? metadata.cwd,
              gitDir: metadata.gitDir ?? `${metadata.cwd}/.git`,
              commonDir: metadata.commonDir ?? `${metadata.cwd}/.git`,
              errorMessage: metadata.errorMessage ?? null,
            } as never;
          }
          return {
            cwd: params.cwd,
            root: params.cwd,
            gitDir: `${params.cwd}/.git`,
            commonDir: `${params.cwd}/.git`,
            isGitRepository: true,
            currentBranch: "feature",
            defaultBranch: "main",
            errorMessage: null,
          } as never;
        }
        case "base-branch": {
          const params = input.params as { cwd: string };
          return {
            cwd: params.cwd,
            local: null,
            remote: null,
            errorMessage: null,
          } as never;
        }
        case "review-summary": {
          const params = input.params as { source: string };
          const result = await reviewDiffPanelTestInvoke("review-summary", input.params);
          if (typeof result === "object" && result !== null && "type" in result) {
            return result as never;
          }
          const snapshot = result as {
            files?: unknown[];
            snapshotGeneration?: number;
          } | null;
          return {
            type: "success",
            source: params.source,
            files: snapshot?.files ?? [],
            snapshotGeneration: snapshot?.snapshotGeneration ?? 1,
            stageCounts: {
              stagedFileCount: 0,
              unstagedFileCount: 0,
              untrackedFileCount: 0,
            },
          } as never;
        }
        case "branch-commits":
          return (await reviewDiffPanelTestInvoke("branch-commits", input.params)) as never;
        case "review-diff":
          return (await reviewDiffPanelTestInvoke("review-diff", input.params)) as never;
        case "review-cat-file": {
          const value = await reviewDiffPanelTestInvoke("review-cat-file", input.params);
          return { type: "success", value } as never;
        }
        case "review-generated-paths":
          return ((await reviewDiffPanelTestInvoke("review-generated-paths", input.params)) ?? {
            paths: [],
            hasLinguistGeneratedAttributes: false,
          }) as never;
        case "review-search":
          return (await reviewDiffPanelTestInvoke("review-search", input.params)) as never;
        case "review-patch":
          return (await reviewDiffPanelTestInvoke("review-patch", input.params)) as never;
        case "subscribe-live-query":
          await reviewDiffPanelTestInvoke("subscribe-live-query", input.params);
          return { subscribed: true } as never;
        case "unsubscribe-live-query":
          await reviewDiffPanelTestInvoke("unsubscribe-live-query", input.params);
          return { unsubscribed: true } as never;
        case "recover-live-query":
          await reviewDiffPanelTestInvoke("recover-live-query", input.params);
          return { recovered: true } as never;
        case "refresh-live-query":
          await reviewDiffPanelTestInvoke("refresh-live-query", input.params);
          return { refreshed: true } as never;
        case "git-init-repo": {
          const params = input.params as { cwd: string };
          return (await reviewDiffPanelTestInvoke("git-init-repo", params.cwd)) as never;
        }
        default:
          throw new Error(`Unsupported test Git worker method: ${input.method}`);
      }
    },
    subscribe: () => () => undefined,
  };
}

function createReviewGitWorkerTestClientWithLiveEvents(
  setPublish: (publish: ((event: GitReviewLiveEvent) => void) | null) => void,
): GitWorkerQueryClient {
  const client = createReviewGitWorkerTestClient();
  return {
    ...client,
    subscribe: (listener) => {
      setPublish((event) =>
        listener({
          type: "git-live-query-event",
          workerId: "git",
          event,
        }),
      );
      return () => setPublish(null);
    },
  };
}

const reviewDiffPanelTestDeps = {
  initialSummaryQuery: true,
  parsePatchFiles: parsePatchFilesForTest,
  readWorkspaceFileMetadata: (input: unknown) =>
    reviewDiffPanelTestInvoke("read-file-metadata", input) as never,
  readWorkspaceFileText: (input: unknown) => reviewDiffPanelTestInvoke("read-file", input) as never,
  gitWorkerClient: createReviewGitWorkerTestClient(),
  theme: "light" as const,
  FileDiff: <LAnnotation, Caret>(props: FileDiffProps<LAnnotation, Caret>) => {
    const { className, fileDiff, options, lineAnnotations, renderAnnotation, selectedLines } =
      props;
    lastFileDiffProps = props as unknown as FileDiffProps<unknown, undefined>;
    return createElement(
      "div",
      {
        className,
        "data-file-diff": fileDiff.name ?? "file",
        "data-file-additions": countTestFileDiffLines(
          (fileDiff as { additionLines?: unknown }).additionLines,
        ),
        "data-file-deletions": countTestFileDiffLines(
          (fileDiff as { deletionLines?: unknown }).deletionLines,
        ),
        "data-line-annotations": String(lineAnnotations?.length ?? 0),
        "data-selected-lines": selectedLines
          ? `${selectedLines.side ?? ""}:${selectedLines.start}-${selectedLines.endSide ?? ""}:${selectedLines.end}`
          : "",
        "data-hunk-separators": testDiffOptionValue(options, "hunkSeparators"),
        "data-collapsed-context-threshold": testDiffOptionValue(
          options,
          "collapsedContextThreshold",
        ),
        "data-expansion-line-count": testDiffOptionValue(options, "expansionLineCount"),
        "data-collapsed": testDiffOptionValue(options, "collapsed"),
        "data-line-diff-type": testDiffOptionValue(options, "lineDiffType"),
        "data-diff-indicators": testDiffOptionValue(options, "diffIndicators"),
      },
      lineAnnotations?.map((annotation, index) =>
        createElement(
          "div",
          {
            key: index,
            "data-rendered-line-annotation": `${annotation.side}:${annotation.lineNumber}`,
          },
          renderAnnotation?.(annotation, fileDiff),
        ),
      ),
    );
  },
};

function buildConversation(): CodexConversationSnapshot {
  return {
    threadId: "thr_review",
    projectId: "codex",
    source: null,
    threadName: "Review",
    threadPreview: "Patch preview",
    modelProvider: "codex",
    cwd: "/tmp/codex",
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    linkedAt: "2026-03-01T00:00:00.000Z",
    resumeState: "resumed",
    turns: [
      {
        threadId: "thr_review",
        turnId: "turn_1",
        status: "completed",
        diff: "diff --git a/src/example.ts b/src/example.ts\nindex 1111111..2222222 100644\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1,2 @@\n export const value = 1;\n+export const review = true;\n",
        itemIds: [],
        items: [],
      },
    ],
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
      canEditUserTurns: true,
      canForkFromTurn: true,
      canSearch: true,
      canCollapseTurns: true,
    },
  };
}

function buildMultiFilePatch(fileCount: number, nested = false): string {
  return Array.from({ length: fileCount }, (_, index) => {
    const suffix = String(index + 1).padStart(3, "0");
    const dirPrefix = nested
      ? `src/domain-${String((index % 8) + 1).padStart(2, "0")}/feature-${String(Math.floor(index / 8) + 1).padStart(2, "0")}`
      : "src";
    const filePath = `${dirPrefix}/file-${suffix}.ts`;
    return [
      `diff --git a/${filePath} b/${filePath}`,
      "index 1111111..2222222 100644",
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      "@@ -1 +1,2 @@",
      ` export const file${suffix} = ${index + 1};`,
      `+export const changed${suffix} = true;`,
      "",
    ].join("\n");
  }).join("\n");
}

function buildGitSummary(
  path: string,
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" = "modified",
) {
  return {
    path,
    previousPath: null,
    status,
    rawStatus: null,
    oldOid: null,
    newOid: null,
    revision: `test:${status}:${path}`,
    additions: 1,
    deletions: 0,
    safety: buildReviewFileSafety(),
  };
}

function splitTestPatchFileDiffs(patch: string): string[] {
  return patch
    .trim()
    .split(/^diff --git /m)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => `diff --git ${chunk}`);
}

function extractTestPatchPath(filePatch: string, index: number): string {
  const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(filePatch);
  return header?.[2] ?? `src/file-${index + 1}.ts`;
}

function buildGitSummariesFromPatch(patch: string) {
  return splitTestPatchFileDiffs(patch).map((filePatch, index) =>
    buildGitSummary(extractTestPatchPath(filePatch, index)),
  );
}

function buildGitDiffResultForTest(input: {
  cwd?: string;
  source?: "unstaged" | "staged" | "branch" | "commit";
  patch: string;
  files?: ReturnType<typeof buildGitSummary>[];
}) {
  const filePatches = splitTestPatchFileDiffs(input.patch);
  const summaries = input.files ?? buildGitSummariesFromPatch(input.patch);
  const files = summaries.map((file, index) => {
    const diff = filePatches[index] ?? "";
    return {
      ...file,
      diff,
      loadStatus: file.safety.renderable
        ? ("loaded" as const)
        : file.safety.skipReason === "binary"
          ? ("binary" as const)
          : ("unsupported" as const),
      renderKey: `${file.previousPath ?? ""}->${file.path}:${file.revision ?? ""}:${diff.length}`,
      diffBytes: diff.length,
      diffError: null,
      canApplyPatchActions: file.safety.renderable && diff.trim().length > 0,
      changedBytes: diff.length,
      tooLarge: false,
      tooLargeReason: null,
    };
  });

  return {
    cwd: input.cwd ?? "/tmp/codex",
    source: input.source ?? "unstaged",
    patch: files
      .map((file) => file.diff)
      .filter(Boolean)
      .join("\n"),
    files,
    isGitRepository: true,
    baseRef: null,
    currentBranch: "feature",
    defaultBranch: "main",
    errorMessage: null,
    snapshotGeneration: 1,
  };
}

beforeEach(() => {
  menuPorts.readTargets.mockReset().mockResolvedValue({
    primary: { id: "cursor", label: "Cursor", opener: "cursor" },
    alternatives: [{ id: "vscode", label: "VS Code", opener: "vscode" }],
  });
  menuPorts.openTarget.mockReset().mockResolvedValue(true);
  menuPorts.showMenu.mockReset().mockResolvedValue(null);
  menuPorts.openUrl.mockReset().mockResolvedValue(true);
  menuPorts.github.mockReset().mockResolvedValue(null);
  localStorage.removeItem(FILE_LINK_OPENER_STORAGE_KEY);
  document.getSelection()?.removeAllRanges();
  __resetReviewDiffBatcherForTests();
  invokeCalls.length = 0;
  startThreadPromptCalls.length = 0;
  clipboardWrites.length = 0;
  mockInvokeImpl = null;
  lastFileDiffProps = null;
  openWorkspaceFileTab.mockClear();
  __resetReviewFullContentStoreForTests();
  __resetReviewCatFileBatcherForTests();
  __resetReviewDiffCommentAttachmentStoreForTests();
  __resetNodexToastStoreForTests();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        clipboardWrites.push(value);
      },
    },
  });
});

async function loadReviewDiffPanelModule() {
  type TestReviewDiffPanelProps = Omit<
    ComponentProps<typeof ReviewDiffPanel>,
    "conversationProjection" | "onStartThreadPrompt"
  > & {
    conversation?: CodexConversationSnapshot | null;
    conversationProjection?: ReviewConversationProjection;
    hostId?: string;
  };

  function TestReviewDiffPanel(props: TestReviewDiffPanelProps) {
    const {
      conversation = null,
      conversationProjection,
      deps,
      hostId = "local",
      ...panelProps
    } = props;
    return (
      <TestQueryProvider>
        <FileLinkOpenerProvider>
          <FileReferenceRouterProvider openWorkspaceFileTab={openWorkspaceFileTab}>
            <FileReferenceHostProvider
              hostId={hostId}
              workspaceRoot={panelProps.projectWorkspacePath ?? null}
            >
              <ReviewDiffPanel
                {...panelProps}
                conversationProjection={
                  conversationProjection ?? buildReviewConversationProjection(conversation)
                }
                deps={{ ...reviewDiffPanelTestDeps, ...deps }}
                onStartThreadPrompt={recordStartThreadPrompt}
              />
            </FileReferenceHostProvider>
          </FileReferenceRouterProvider>
        </FileLinkOpenerProvider>
      </TestQueryProvider>
    );
  }

  return { ReviewDiffPanel: TestReviewDiffPanel };
}

function reviewTreeRoot(container: HTMLElement): ShadowRoot {
  const root = container.querySelector("file-tree-container")?.shadowRoot;
  if (!root) throw new Error("Expected mounted review file tree");
  return root;
}

async function waitForReviewTreePath(container: HTMLElement, path: string): Promise<HTMLElement> {
  let row: Element | null = null;
  await waitFor(() => {
    row = reviewTreeRoot(container).querySelector(
      `[role="treeitem"][data-item-path="${path}"], [role="treeitem"][data-item-path="${path}/"]`,
    );
    if (!row) {
      throw new Error(`Expected review tree row for ${path}.`);
    }
  });
  if (!isDomElement(row)) {
    throw new Error(`Expected review tree row for ${path}.`);
  }
  return row;
}

async function openReviewOptionsMenu(view: {
  getByLabelText: (text: string) => HTMLElement;
}): Promise<void> {
  await act(async () => {
    fireEvent.mouseDown(view.getByLabelText("Review options"), {
      button: 0,
      ctrlKey: false,
    });
    await Promise.resolve();
  });
  await settleAsyncRender();
}

async function dispatchReviewEvent(callback: () => void): Promise<void> {
  await act(async () => {
    callback();
    await Promise.resolve();
  });
  await settleAsyncRender();
}

async function unmountReviewView(view: RenderResult): Promise<void> {
  await act(async () => {
    view.unmount();
    await Promise.resolve();
  });
  await settleAsyncRender();
}

async function waitForGitReviewDiffCall(): Promise<void> {
  await waitFor(() => {
    if (!invokeCalls.some((call) => call[0] === "review-diff")) {
      throw new Error("Expected git review diff call.");
    }
  });
  await settleAsyncRender();
}

async function waitForGitReviewSnapshotCall(): Promise<void> {
  await waitFor(() => {
    if (!invokeCalls.some((call) => call[0] === "review-summary")) {
      throw new Error("Expected git review snapshot call.");
    }
  });
  await settleAsyncRender();
}

async function settleAsyncRender(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

describe("review diff panel", () => {
  test("routes review filenames to Files and preserves durable activation", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel conversation={buildConversation()} projectWorkspacePath="/tmp/codex" />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();
    const filename = view.getByRole("button", { name: "example.ts" });

    fireEvent.click(filename);
    await settleAsyncRender();
    expect(openWorkspaceFileTab).toHaveBeenLastCalledWith({
      cwd: "/tmp/codex",
      hostId: "local",
      path: "/tmp/codex/src/example.ts",
      title: "src/example.ts",
      panelId: "right",
      mode: "preview",
      workspaceRoot: "/tmp/codex",
      location: { line: 1 },
    });

    fireEvent.doubleClick(filename);
    await settleAsyncRender();
    expect(openWorkspaceFileTab).toHaveBeenLastCalledWith({
      cwd: "/tmp/codex",
      hostId: "local",
      path: "/tmp/codex/src/example.ts",
      title: "src/example.ts",
      panelId: "right",
      mode: "durable",
      workspaceRoot: "/tmp/codex",
      location: { line: 1 },
    });
  });

  test("invalidates full content when patch text changes with the same Git IDs and line counts", async () => {
    const store = await import("@/features/review/data/review-full-content-store");
    const readFullContent = vi.spyOn(store, "useReviewFullContentState");
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel conversation={buildConversation()} projectWorkspacePath="/tmp/codex" />
      </NodexTooltipProvider>,
    );
    await waitFor(() => expect(readFullContent).toHaveBeenCalled());
    const firstKey = readFullContent.mock.lastCall?.[0];
    const changed = buildConversation();
    changed.turns[0]!.diff = changed.turns[0]!.diff!.replace("true", "false");
    view.rerender(
      <NodexTooltipProvider>
        <ReviewDiffPanel conversation={changed} projectWorkspacePath="/tmp/codex" />
      </NodexTooltipProvider>,
    );
    await waitFor(() => expect(readFullContent.mock.lastCall?.[0]).not.toBe(firstKey));
    readFullContent.mockRestore();
  });

  test("prefers the explicitly selected turn diff when provided", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();

    const { container, getByText } = render(
      <NodexTooltipProvider>
        <PrepareReviewOpen
          intent={{
            source: {
              kind: "selected-turn",
              threadId: "thr_review",
              turnId: "turn_selected",
              entryId: "turn-diff:turn_selected",
            },
          }}
        />
        <ReviewDiffPanel
          conversation={buildConversation()}
          projectWorkspacePath="/tmp/codex"
          selectedTurnDiff={{
            threadId: "thr_review",
            turnId: "turn_selected",
            entryId: "turn-diff:turn_selected",
            patch:
              "diff --git a/src/selected.ts b/src/selected.ts\nindex 1111111..2222222 100644\n--- a/src/selected.ts\n+++ b/src/selected.ts\n@@ -1 +1 @@\n-export const selected = false;\n+export const selected = true;\n",
            cwd: "/tmp/codex",
            showRevertButton: true,
          }}
        />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();

    expect(getByText("Last turn").textContent).toBe("Last turn");
    expect(textContent(container).includes("selected.ts")).toBe(true);
    expect(container.querySelector('[data-file-diff="src/selected.ts"]')).not.toBeNull();
  });

  test("filters generated turn files from both the tree and the diff list", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const conversation = buildConversation();
    conversation.turns[0]!.diff = buildMultiFilePatch(2);
    mockInvokeImpl = async (channel) =>
      channel === "review-generated-paths"
        ? { paths: ["/tmp/codex/src/file-001.ts"], hasLinguistGeneratedAttributes: true }
        : null;
    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel
          conversation={conversation}
          projectWorkspacePath="/tmp/codex"
          initialFileTreeOpen
        />
      </NodexTooltipProvider>,
    );
    await waitForReviewTreePath(view.container, "src/file-001.ts");
    const options = await view.findByRole("button", { name: "Filter options" });
    await dispatchReviewEvent(() => fireEvent.click(options));
    await dispatchReviewEvent(() =>
      fireEvent.click(view.getByRole("menuitemcheckbox", { name: "Filter generated files" })),
    );
    await waitFor(() => {
      expect(
        reviewTreeRoot(view.container).querySelector(
          '[role="treeitem"][data-item-path="src/file-001.ts"]',
        ),
      ).toBeNull();
      expect(view.container.querySelector('[data-review-path="src/file-001.ts"]')).toBeNull();
    });
    expect(await waitForReviewTreePath(view.container, "src/file-002.ts")).toBeDefined();
  });

  test("renders binary metadata rows without invoking textual diff renderers", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    mockInvokeImpl = async (channel: unknown) => {
      if (channel !== "review-diff") return null;
      return {
        cwd: "/tmp/storybook/binary",
        source: "unstaged",
        patch: "",
        files: [
          {
            path: "assets/logo.png",
            previousPath: null,
            status: "added",
            additions: null,
            deletions: null,
            safety: buildReviewFileSafety({
              binary: true,
              sizeBytes: 24,
              mimeType: "image/png",
            }),
          },
        ],
        isGitRepository: true,
        baseRef: null,
        currentBranch: "feature",
        defaultBranch: "main",
        errorMessage: null,
      };
    };

    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel
          conversation={buildConversation()}
          projectWorkspacePath="/tmp/storybook/binary"
          initialSource="unstaged"
        />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();
    await waitForGitReviewSnapshotCall();
    await waitFor(() => {
      if (!view.container.querySelector('[data-review-diff-placeholder="binary"]')) {
        throw new Error("Expected binary placeholder to render.");
      }
    });

    expect(textContent(view.container).includes("Binary file changed")).toBe(true);
    expect(view.container.querySelector("[data-file-diff]")).toBe(null);
    expect(view.container.querySelector('[data-multi-file-diff="true"]')).toBe(null);
  });

  test("loads full metadata only after a git-backed row enters the viewport", async () => {
    const intersectionObserver = installControlledIntersectionObserver();
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    mockInvokeImpl = async (channel: unknown) => {
      if (channel === "review-diff") {
        return {
          cwd: "/tmp/codex",
          source: "unstaged",
          patch:
            "diff --git a/src/git.ts b/src/git.ts\nindex 1111111..2222222 100644\n--- a/src/git.ts\n+++ b/src/git.ts\n@@ -1 +1,2 @@\n export const git = 1;\n+export const diff = true;\n",
          files: [buildGitSummary("src/git.ts")],
          isGitRepository: true,
          baseRef: null,
          currentBranch: "feature",
          defaultBranch: "main",
          errorMessage: null,
        };
      }
      if (channel === "review-cat-file") {
        return {
          snapshotGeneration: 1,
          results: [
            {
              type: "success",
              lines: ["export const git = 1;\n"],
            },
            {
              type: "success",
              lines: ["export const git = 1;\n", "export const diff = true;\n"],
            },
          ],
        };
      }
      return null;
    };

    try {
      const view = render(
        <NodexTooltipProvider>
          <ReviewDiffPanel
            conversation={buildConversation()}
            projectWorkspacePath="/tmp/codex"
            initialSource="unstaged"
            deps={{
              ...reviewDiffPanelTestDeps,
              parsePatchFiles,
            }}
          />
        </NodexTooltipProvider>,
      );

      await settleAsyncRender();
      await waitForGitReviewDiffCall();
      const row = await waitFor(() => {
        const candidate = view.container.querySelector('section[data-review-path="src/git.ts"]');
        if (!candidate) throw new Error("Expected the git review row.");
        return candidate;
      });
      await waitFor(() => {
        expect(view.container.querySelector('[data-file-diff="src/git.ts"]')).not.toBeNull();
      });
      expect(lastFileDiffProps?.fileDiff.isPartial).toBe(true);

      expect(invokeCalls.some((call) => call[0] === "review-cat-file")).toBe(false);
      await waitFor(() => {
        expect(intersectionObserver.isObserved(row)).toBe(true);
      });

      await act(async () => {
        intersectionObserver.emit(row);
        await Promise.resolve();
      });

      await waitFor(() => {
        if (!invokeCalls.some((call) => call[0] === "review-cat-file")) {
          throw new Error("Expected visible row contents to load.");
        }
      });
      await waitFor(() => {
        const fileDiff = view.container.querySelector('[data-file-diff="src/git.ts"]');
        expect(fileDiff?.getAttribute("data-file-additions")).toBe("2");
        expect(fileDiff?.getAttribute("data-file-deletions")).toBe("1");
      });
      expect(view.container.querySelector("[data-multi-file-diff]")).toBe(null);
      await openReviewOptionsMenu(view);
      expect(Boolean(view.baseElement.textContent?.includes("Enable rich preview"))).toBe(true);
    } finally {
      intersectionObserver.restore();
    }
  });

  test("isolates a failed path diff from successfully loaded siblings", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const loadedPatch = [
      "diff --git a/src/loaded.ts b/src/loaded.ts",
      "index 1111111..2222222 100644",
      "--- a/src/loaded.ts",
      "+++ b/src/loaded.ts",
      "@@ -1 +1,2 @@",
      " export const loaded = 1;",
      "+export const changed = true;",
      "",
    ].join("\n");
    const failedPatch = [
      "diff --git a/src/failed.ts b/src/failed.ts",
      "index 1111111..2222222 100644",
      "--- a/src/failed.ts",
      "+++ b/src/failed.ts",
      "@@ -1 +1,2 @@",
      " export const failed = 1;",
      "+export const unavailable = true;",
      "",
    ].join("\n");
    const loadedSummary = buildGitSummary("src/loaded.ts");
    const failedSummary = buildGitSummary("src/failed.ts");

    mockInvokeImpl = async (channel: unknown) => {
      if (channel === "review-summary") {
        return {
          cwd: "/tmp/codex",
          source: "unstaged",
          patch: "",
          files: [loadedSummary, failedSummary],
          isGitRepository: true,
          baseRef: null,
          currentBranch: "feature",
          defaultBranch: "main",
          errorMessage: null,
          snapshotGeneration: 1,
        };
      }
      if (channel !== "review-diff") return null;

      const result = buildGitDiffResultForTest({
        patch: `${loadedPatch}\n${failedPatch}`,
        files: [loadedSummary, failedSummary],
      });
      return {
        ...result,
        patch: loadedPatch,
        files: result.files.map((file) =>
          file.path === failedSummary.path
            ? {
                ...file,
                diff: "",
                loadStatus: "load-failed" as const,
                renderKey: `${file.renderKey}:load-failed`,
                diffBytes: 0,
                diffError: "Could not load this path.",
                canApplyPatchActions: false,
                changedBytes: 0,
              }
            : file,
        ),
      };
    };

    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel
          conversation={buildConversation()}
          projectWorkspacePath="/tmp/codex"
          initialSource="unstaged"
        />
      </NodexTooltipProvider>,
    );

    await waitFor(() => {
      expect(view.container.querySelector('[data-file-diff="src/loaded.ts"]')).not.toBeNull();
      expect(
        view.container.querySelector(
          '[data-review-path="src/failed.ts"] [data-review-diff-placeholder="load-failed"]',
        ),
      ).not.toBeNull();
    });

    const diffCalls = invokeCalls.filter((call) => call[0] === "review-diff");
    expect(diffCalls).toHaveLength(1);
    expect(
      (
        diffCalls[0]?.[1] as {
          files?: Array<{ path: string }>;
        }
      ).files?.map((file) => file.path),
    ).toEqual([loadedSummary.path, failedSummary.path]);
  });

  test("keeps an in-flight tracked path query across the complete publication", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const trackedPatch = [
      "diff --git a/src/tracked-pending.ts b/src/tracked-pending.ts",
      "index 1111111..2222222 100644",
      "--- a/src/tracked-pending.ts",
      "+++ b/src/tracked-pending.ts",
      "@@ -1 +1,2 @@",
      " export const tracked = 1;",
      "+export const changed = true;",
      "",
    ].join("\n");
    const untrackedPatch = [
      "diff --git a/src/untracked-complete.ts b/src/untracked-complete.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/untracked-complete.ts",
      "@@ -0,0 +1 @@",
      "+export const untracked = true;",
      "",
    ].join("\n");
    const trackedSummary = buildGitSummary("src/tracked-pending.ts");
    const untrackedSummary = buildGitSummary("src/untracked-complete.ts", "untracked");
    const trackedResult = buildGitDiffResultForTest({
      patch: trackedPatch,
      files: [trackedSummary],
    });
    const untrackedResult = buildGitDiffResultForTest({
      patch: untrackedPatch,
      files: [untrackedSummary],
    });
    let publish: ((event: GitReviewLiveEvent) => void) | null = null;
    let subscriptionId = "";
    let resolveTrackedDiff: ((result: typeof trackedResult) => void) | null = null;

    mockInvokeImpl = async (channel: unknown, payload: unknown) => {
      if (
        channel === "subscribe-live-query" &&
        typeof payload === "object" &&
        payload !== null &&
        "subscriptionId" in payload &&
        "query" in payload &&
        payload.query !== null &&
        typeof payload.query === "object" &&
        "method" in payload.query &&
        payload.query.method === "review-summary"
      ) {
        subscriptionId = String(payload.subscriptionId);
        return null;
      }
      if (channel !== "review-diff") return null;
      const requestedPaths =
        typeof payload === "object" && payload !== null && "files" in payload
          ? (payload as { files: Array<{ path: string }> }).files.map((file) => file.path)
          : [];
      if (requestedPaths.includes(trackedSummary.path)) {
        return new Promise<typeof trackedResult>((resolve) => {
          resolveTrackedDiff = resolve;
        });
      }
      return untrackedResult;
    };

    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel
          conversation={buildConversation()}
          projectWorkspacePath="/tmp/codex"
          initialSource="unstaged"
          deps={{
            initialSummaryQuery: false,
            gitWorkerClient: createReviewGitWorkerTestClientWithLiveEvents((listener) => {
              publish = listener;
            }),
          }}
        />
      </NodexTooltipProvider>,
    );
    await waitFor(() => {
      if (!publish || !subscriptionId) {
        throw new Error("Expected live summary subscription.");
      }
    });

    await act(async () => {
      publish?.({
        type: "git-live-query-updated",
        subscriptionId,
        generation: 1,
        requiresRecovery: false,
        phase: "tracked",
        method: "review-summary",
        result: {
          type: "success",
          source: "unstaged",
          files: [trackedSummary],
          snapshotGeneration: 1,
          stageCounts: {
            stagedFileCount: 0,
            unstagedFileCount: 1,
            untrackedFileCount: 1,
          },
          untrackedFilesOmitted: 0,
        },
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      if (!resolveTrackedDiff) {
        throw new Error("Expected the tracked diff request to be in flight.");
      }
    });

    await act(async () => {
      publish?.({
        type: "git-live-query-updated",
        subscriptionId,
        generation: 1,
        requiresRecovery: false,
        phase: "complete",
        method: "review-summary",
        result: {
          type: "success",
          source: "unstaged",
          files: [{ ...trackedSummary }, untrackedSummary],
          snapshotGeneration: 1,
          stageCounts: {
            stagedFileCount: 0,
            unstagedFileCount: 1,
            untrackedFileCount: 1,
          },
          untrackedFilesOmitted: 0,
        },
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      const diffCalls = invokeCalls.filter((call) => call[0] === "review-diff");
      if (diffCalls.length < 2) {
        throw new Error("Expected the complete-phase untracked request.");
      }
    });

    const trackedRequests = invokeCalls.filter((call) => {
      if (call[0] !== "review-diff") return false;
      return (call[1] as { files?: Array<{ path: string }> }).files?.some(
        (file) => file.path === trackedSummary.path,
      );
    });
    expect(trackedRequests).toHaveLength(1);
    expect(invokeCalls.filter((call) => call[0] === "worker-request-cancel")).toHaveLength(0);

    await act(async () => {
      resolveTrackedDiff?.(trackedResult);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        view.container.querySelector('[data-file-diff="src/tracked-pending.ts"]'),
      ).not.toBeNull();
      expect(
        view.container.querySelector('[data-file-diff="src/untracked-complete.ts"]'),
      ).not.toBeNull();
    });
  });

  test("keeps a last-turn added file on its complete patch without reading the workspace file", async () => {
    mockInvokeImpl = async (channel: unknown) => {
      if (channel === "read-file") {
        return {
          content: 'export const source = "workspace";\n',
          binary: false,
          truncated: false,
        };
      }
      return null;
    };
    const conversation = buildConversation();
    conversation.turns[0]!.diff = [
      "diff --git a/src/created.ts b/src/created.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/created.ts",
      "@@ -0,0 +1,2 @@",
      "+export const created = true;",
      '+export const source = "patch";',
      "",
    ].join("\n");

    const view = render(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <ReviewDiffPanel
            conversationProjection={buildReviewConversationProjection(conversation)}
            onStartThreadPrompt={recordStartThreadPrompt}
            projectWorkspacePath="/tmp/codex"
            deps={{
              ...reviewDiffPanelTestDeps,
              parsePatchFiles: parseAddedPatchFileWithLineArraysForTest,
            }}
          />
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );

    await settleAsyncRender();
    const fileDiff = await waitFor(() => {
      const candidate = view.container.querySelector('[data-file-diff="src/created.ts"]');
      if (!candidate) throw new Error("Expected the added file diff.");
      return candidate;
    });

    expect(fileDiff.getAttribute("data-file-additions")).toBe("2");
    expect(fileDiff.getAttribute("data-file-deletions")).toBe("0");
    expect(invokeCalls.some((call) => call[0] === "read-file")).toBe(false);
    expect(invokeCalls.some((call) => call[0] === "review-cat-file")).toBe(false);
  });

  test("cancels an in-flight Git review summary after unmount", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const baseClient = createReviewGitWorkerTestClient();
    let summarySignal: AbortSignal | undefined;
    mockInvokeImpl = async (channel: unknown) => {
      if (channel === "stable-metadata") {
        return {
          cwd: "/tmp/codex",
          isGitRepository: true,
          currentBranch: "feature",
          defaultBranch: "main",
        };
      }
      return null;
    };

    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel
          conversation={buildConversation()}
          projectWorkspacePath="/tmp/codex"
          initialSource="unstaged"
          deps={{
            gitWorkerClient: {
              ...baseClient,
              request: async (input) => {
                if (input.method !== "review-summary") {
                  return (await baseClient.request(input as never)) as never;
                }
                summarySignal = input.signal;
                return await new Promise<never>(() => {});
              },
            },
          }}
        />
      </NodexTooltipProvider>,
    );

    await waitFor(() => expect(summarySignal).toBeDefined());
    await unmountReviewView(view);
    await settleAsyncRender();

    expect(summarySignal?.aborted).toBe(true);
  });

  test("captures the context menu selection before discovering file targets", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel conversation={buildConversation()} projectWorkspacePath="/tmp/codex" />
      </NodexTooltipProvider>,
    );
    await settleAsyncRender();
    let releaseTargets: (() => void) | undefined;
    menuPorts.readTargets.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseTargets = () => resolve({ primary: null, alternatives: [] });
        }),
    );
    menuPorts.showMenu.mockResolvedValueOnce("copy-selection");
    const code = document.createElement("span");
    code.textContent = "  const selected = true;  ";
    view.container.querySelector("[data-file-diff]")!.append(code);
    const range = document.createRange();
    range.selectNodeContents(code);
    document.getSelection()?.addRange(range);
    await dispatchReviewEvent(() => {
      fireEvent.contextMenu(code);
    });
    expect(menuPorts.readTargets).toHaveBeenCalledWith("/tmp/codex/src/example.ts");
    expect(menuPorts.showMenu).not.toHaveBeenCalled();
    await act(async () => {
      document.getSelection()?.removeAllRanges();
      releaseTargets?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(clipboardWrites).toEqual(["const selected = true;"]));
    expect(menuPorts.showMenu.mock.calls[0]?.[0]).toContainEqual(
      expect.objectContaining({ id: "copy-selection" }),
    );
  });

  test.each([
    ["copy-path", "/tmp/codex/src/example.ts"],
    ["copy-relative-path", "src/example.ts"],
  ])("copies the context menu %s path form", async (action, expected) => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel conversation={buildConversation()} projectWorkspacePath="/tmp/codex" />
      </NodexTooltipProvider>,
    );
    await settleAsyncRender();
    menuPorts.showMenu.mockResolvedValueOnce(action);
    await dispatchReviewEvent(() => {
      fireEvent.contextMenu(view.container.querySelector("[data-file-diff]")!);
    });
    await waitFor(() => expect(clipboardWrites).toEqual([expected]));
  });

  test.each(["local", "remote-one"])(
    "opens the source file on GitHub using its %s host",
    async (hostId) => {
      const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
      menuPorts.github.mockResolvedValue(
        "https://github.com/example/project/blob/feature/menu/src/example.ts",
      );
      const view = render(
        <NodexTooltipProvider>
          <ReviewDiffPanel
            conversation={buildConversation()}
            projectWorkspacePath="/tmp/codex"
            hostId={hostId}
          />
        </NodexTooltipProvider>,
      );
      await settleAsyncRender();
      menuPorts.showMenu.mockResolvedValueOnce("open-in-github");
      await dispatchReviewEvent(() => {
        fireEvent.contextMenu(view.container.querySelector("[data-file-diff]")!);
      });
      await waitFor(() =>
        expect(menuPorts.openUrl).toHaveBeenCalledWith({
          url: "https://github.com/example/project/blob/feature/menu/src/example.ts",
          hostId,
          initiator: "review_github_link",
        }),
      );
      expect(menuPorts.github).toHaveBeenCalledExactlyOnceWith({
        hostId,
        path: "/tmp/codex/src/example.ts",
      });
      if (hostId !== "local") {
        expect(menuPorts.readTargets).not.toHaveBeenCalled();
        expect(menuPorts.showMenu.mock.calls[0]?.[0]).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ id: "open-primary" })]),
        );
      }
    },
  );

  test("leaves comment editor context menus with the editable control", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel conversation={buildConversation()} projectWorkspacePath="/tmp/codex" />
      </NodexTooltipProvider>,
    );
    await settleAsyncRender();
    const editor = document.createElement("textarea");
    view.container.querySelector("[data-file-diff]")!.append(editor);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await dispatchReviewEvent(() => {
      editor.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(menuPorts.showMenu).not.toHaveBeenCalled();
    expect(menuPorts.readTargets).not.toHaveBeenCalled();
  });
});
