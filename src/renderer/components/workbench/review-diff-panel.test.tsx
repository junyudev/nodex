import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createElement, useEffect, useRef, type ComponentProps } from "react";
import { act, fireEvent, type RenderResult, waitFor } from "@testing-library/react";
import { renderWithMaitai as render, textContent } from "../../test/dom";
import { TestQueryProvider } from "../../test/query";
import { __resetNodexToastStoreForTests, NodexToastProvider } from "../ui/toast";
import { NodexTooltipProvider } from "../ui/tooltip";
import { FileReferenceRouterProvider } from "@/lib/file-reference-router";
import { NODEX_REVIEW_DIFF_EXPANSION_LINE_COUNT } from "../../lib/diff-presentation";
import type { CodexConversationSnapshot, GitReviewLiveEvent } from "@/lib/types";
import { buildReviewFileSafety } from "../../../shared/review-file-safety";
import { ReviewDiffPanel } from "./review-diff-panel";
import { parsePatchFiles } from "@pierre/diffs";
import { __resetReviewFullContentStoreForTests } from "@/features/review/data/review-full-content-store";
import { __resetReviewCatFileBatcherForTests } from "@/features/review/data/review-cat-file-batcher";
import { __resetReviewDiffBatcherForTests } from "@/features/review/data/review-diff-batcher";
import {
  __resetReviewDiffCommentAttachmentStoreForTests,
  addReviewDiffCommentAttachment,
} from "@/lib/review-diff-comment-attachment-store";
import {
  buildReviewConversationProjection,
  type ReviewConversationProjection,
} from "@/features/review/model/review-conversation-projection";
import { installReviewRuntimeProbe } from "@/features/review/testing/review-runtime-probe";
import type { FileDiffMetadata, FileDiffProps } from "@pierre/diffs/react";
import { useSetScopedAtom } from "@/lib/maitai";
import {
  prepareReviewOpenAtom,
  type ReviewOpenIntent,
} from "@/features/review/model/review-view-state";
import { canonicalizeReviewPath } from "@/features/review/model/review-path";
import type { GitWorkerQueryClient } from "@/features/review/data/git-query";

const invokeCalls: unknown[][] = [];
const startThreadPromptCalls: Array<{ threadId: string; prompt: string }> = [];
const clipboardWrites: string[] = [];
let mockInvokeImpl: ((...args: unknown[]) => Promise<unknown>) | null = null;
let lastFileDiffProps: FileDiffProps<unknown> | null = null;
const openWorkspaceFileTab = vi.fn(async () => true);

function PrepareReviewOpen({ intent }: { readonly intent: ReviewOpenIntent }) {
  const prepareOpen = useSetScopedAtom(prepareReviewOpenAtom);
  const intentRef = useRef(intent);
  useEffect(() => {
    prepareOpen(intentRef.current);
  }, [prepareOpen]);
  return null;
}

function ReviewOpenButton({ intent }: { readonly intent: ReviewOpenIntent }) {
  const prepareOpen = useSetScopedAtom(prepareReviewOpenAtom);
  return (
    <button type="button" onClick={() => prepareOpen(intent)}>
      Open Review file
    </button>
  );
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
  useTheme: () => ({
    theme: "light" as const,
    resolved: "light" as const,
    setTheme: () => {},
  }),
  FileDiff: <LAnnotation,>(props: FileDiffProps<LAnnotation>) => {
    const { className, fileDiff, options, lineAnnotations, renderAnnotation, selectedLines } =
      props;
    lastFileDiffProps = props as unknown as FileDiffProps<unknown>;
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
          renderAnnotation?.(annotation),
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
      canEditLastUserTurn: true,
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

function buildRepeatedFilePatch(pathName = "src/example.ts"): string {
  return [
    `diff --git a/${pathName} b/${pathName}`,
    "index 1111111..2222222 100644",
    `--- a/${pathName}`,
    `+++ b/${pathName}`,
    "@@ -1 +1 @@",
    "-export const value = 1;",
    "+export const intermediate = 2;",
    "",
    `diff --git a/${pathName} b/${pathName}`,
    "index 2222222..3333333 100644",
    `--- a/${pathName}`,
    `+++ b/${pathName}`,
    "@@ -1 +1,2 @@",
    "-export const intermediate = 2;",
    "+export const finalValue = 3;",
    "+export const secondSectionOnly = true;",
    "",
  ].join("\n");
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
  };

  function TestReviewDiffPanel(props: TestReviewDiffPanelProps) {
    const { conversation = null, conversationProjection, deps, ...panelProps } = props;
    return (
      <TestQueryProvider>
        <FileReferenceRouterProvider openWorkspaceFileTab={openWorkspaceFileTab}>
          <ReviewDiffPanel
            {...panelProps}
            conversationProjection={
              conversationProjection ?? buildReviewConversationProjection(conversation)
            }
            deps={{ ...reviewDiffPanelTestDeps, ...deps }}
            onStartThreadPrompt={recordStartThreadPrompt}
          />
        </FileReferenceRouterProvider>
      </TestQueryProvider>
    );
  }

  return { ReviewDiffPanel: TestReviewDiffPanel };
}

async function waitForReviewTree(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    if (!container.querySelector('[data-review-tree-item="true"]')) {
      throw new Error("Expected review tree items to render.");
    }
  });
}

async function waitForReviewTreePath(container: HTMLElement, path: string): Promise<HTMLElement> {
  let row: Element | null = null;
  await waitFor(() => {
    row = container.querySelector(`[data-review-tree-path="${path}"]`);
    if (!row) {
      throw new Error(`Expected review tree row for ${path}.`);
    }
  });
  if (!isDomElement(row)) {
    throw new Error(`Expected review tree row for ${path}.`);
  }
  return row;
}

async function waitForMenuItem(baseElement: HTMLElement, text: string): Promise<HTMLElement> {
  let item: Element | null = null;
  await waitFor(() => {
    item =
      Array.from(baseElement.ownerDocument.querySelectorAll('[role="menuitem"]')).find(
        (node) => node.textContent?.includes(text) === true,
      ) ?? null;
    if (!item) {
      throw new Error(`Expected menu item containing ${text}.`);
    }
  });
  if (!isDomElement(item)) {
    throw new Error(`Expected menu item containing ${text}.`);
  }
  return item;
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

async function clickReviewMenuItem(menuItem: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(menuItem);
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

async function waitForGitReviewPatchCall(): Promise<void> {
  await waitFor(() => {
    if (!invokeCalls.some((call) => call[0] === "review-patch")) {
      throw new Error("Expected git review patch call.");
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
  test("renders last-turn file diffs from the active conversation", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();

    const { container, getByText } = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel conversation={buildConversation()} projectWorkspacePath="/tmp/codex" />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();

    expect(getByText("Last turn").textContent).toBe("Last turn");
    expect(textContent(container).includes("example.ts")).toBe(true);
    expect(container.querySelector('[data-file-diff="src/example.ts"]')).not.toBeNull();
  });

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

  test("passes Codex review diff options to rendered file diffs", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();

    const { container } = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel conversation={buildConversation()} projectWorkspacePath="/tmp/codex" />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();

    const renderedFileDiff = container.querySelector('[data-file-diff="src/example.ts"]');
    expect(renderedFileDiff).not.toBeNull();
    expect(renderedFileDiff?.getAttribute("data-hunk-separators")).toBe("line-info");
    expect(renderedFileDiff?.getAttribute("data-collapsed-context-threshold")).toBe("1");
    expect(renderedFileDiff?.getAttribute("data-expansion-line-count")).toBe(
      String(NODEX_REVIEW_DIFF_EXPANSION_LINE_COUNT),
    );
    expect(renderedFileDiff?.getAttribute("data-line-diff-type")).toBe("word-alt");
    expect(renderedFileDiff?.getAttribute("data-diff-indicators")).toBe("bars");
  });

  test("folds repeated diff sections for the same path into one review entry", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const conversation = buildConversation();
    conversation.turns[0]!.diff = buildRepeatedFilePatch();

    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel
          conversation={conversation}
          projectWorkspacePath="/tmp/codex"
          initialFileTreeOpen
        />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();
    await waitForReviewTreePath(view.container, "src/example.ts");

    const reviewRows = view.container.querySelectorAll(
      '.codex-review-diff-card[data-review-path="src/example.ts"]',
    );
    const treeRows = view.container.querySelectorAll(
      '[data-item-type="file"][data-review-tree-path="src/example.ts"]',
    );
    const renderedFileDiffs = view.container.querySelectorAll('[data-file-diff="src/example.ts"]');
    const rowStats = reviewRows[0]?.querySelector('span[data-thread-find-skip="true"]');

    expect(reviewRows.length).toBe(1);
    expect(treeRows.length).toBe(1);
    expect(renderedFileDiffs.length).toBe(1);
    expect(renderedFileDiffs[0]?.getAttribute("data-file-additions")).toBe("2");
    expect(rowStats?.textContent?.includes("+3") ?? false).toBe(true);
    expect(rowStats?.textContent?.includes("-2") ?? false).toBe(true);
  });

  test("prefers the raw completed turn-diff item over stale last-turn diff text", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const conversation = buildConversation();
    conversation.turns[0]!.diff =
      "diff --git a/src/stale.ts b/src/stale.ts\n--- a/src/stale.ts\n+++ b/src/stale.ts\n@@ -1 +1 @@\n-old\n+stale\n";
    conversation.turns[0]!.items = [
      {
        threadId: "thr_review",
        turnId: "turn_1",
        entryId: "turn-diff:turn_1",
        itemId: "turn-diff:turn_1",
        type: "turn_diff",
        kind: "systemEvent",
        semanticKind: "diff",
        status: "completed",
        source: "live",
        sequence: 0,
        rawItem: {
          type: "turn-diff",
          unifiedDiff:
            "diff --git a/src/raw-canonical.ts b/src/raw-canonical.ts\n--- a/src/raw-canonical.ts\n+++ b/src/raw-canonical.ts\n@@ -1 +1 @@\n-old\n+canonical\n",
        },
        createdAt: 1,
        updatedAt: 1,
      },
    ];

    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel conversation={conversation} projectWorkspacePath="/tmp/codex" />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();

    expect(view.container.querySelector('[data-file-diff="src/raw-canonical.ts"]')).not.toBeNull();
    expect(view.container.querySelector('[data-file-diff="src/stale.ts"]')).toBe(null);
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

  test("uses selected turn diff source and focuses the target path", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const scrollTargets: string[] = [];
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function scrollIntoViewForTest() {
      const reviewPath = this.getAttribute("data-review-path");
      if (reviewPath) scrollTargets.push(reviewPath);
    };

    try {
      const { container, getByText } = render(
        <NodexTooltipProvider>
          <ReviewOpenButton
            intent={{
              source: {
                kind: "selected-turn",
                threadId: "thr_review",
                turnId: "turn_1",
                entryId: "turn-diff:turn_1",
              },
              targetPath: canonicalizeReviewPath("src/selected.ts"),
            }}
          />
          <ReviewDiffPanel
            conversation={buildConversation()}
            projectWorkspacePath="/tmp/codex"
            selectedTurnDiff={{
              threadId: "thr_review",
              turnId: "turn_1",
              entryId: "turn-diff:turn_1",
              patch:
                "diff --git a/src/selected.ts b/src/selected.ts\nindex 1111111..2222222 100644\n--- a/src/selected.ts\n+++ b/src/selected.ts\n@@ -1 +1 @@\n-export const selected = false;\n+export const selected = true;\n",
              cwd: "/tmp/codex",
              showRevertButton: true,
            }}
          />
        </NodexTooltipProvider>,
      );

      fireEvent.click(getByText("Open Review file"));
      await waitFor(() => {
        expect(scrollTargets.includes("src/selected.ts")).toBe(true);
      });
      fireEvent.click(getByText("Open Review file"));
      await waitFor(() => {
        expect(scrollTargets.filter((path) => path === "src/selected.ts").length).toBe(2);
      });
      expect(container.querySelector('[data-review-path="src/selected.ts"]')).not.toBeNull();
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  test("keeps last-turn source while focusing a selected path", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();

    const { container } = render(
      <NodexTooltipProvider>
        <PrepareReviewOpen
          intent={{
            source: { kind: "last-turn", threadId: "thr_review" },
            targetPath: canonicalizeReviewPath("src/example.ts"),
          }}
        />
        <ReviewDiffPanel conversation={buildConversation()} projectWorkspacePath="/tmp/codex" />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();

    expect(textContent(container).includes("example.ts")).toBe(true);
    expect(textContent(container).includes("selected.ts")).toBe(false);
    expect(container.querySelector('[data-review-path="src/example.ts"]')).not.toBeNull();
  });

  test("opens the file tree when requested", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();

    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel conversation={buildConversation()} projectWorkspacePath="/tmp/codex" />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();
    await dispatchReviewEvent(() => {
      fireEvent.click(view.getByLabelText("Show files"));
    });

    expect(view.getByPlaceholderText("Filter files…").getAttribute("placeholder")).toBe(
      "Filter files…",
    );
    expect(textContent(view.container).includes("src")).toBe(true);
    expect(textContent(view.container).includes("example.ts")).toBe(true);
    expect(view.container.querySelector('[data-item-type="folder"]')).not.toBeNull();
    expect(view.container.querySelector('[data-item-type="file"]')).not.toBeNull();
    expect(
      view.container.querySelector('[data-item-type="file"] [data-icon-token="typescript"]'),
    ).not.toBeNull();
    const separator = view.container.querySelector(
      '[role="separator"][aria-orientation="vertical"]',
    );
    expect(separator).not.toBeNull();
  });

  test("reveals the diff selected from the file tree", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const conversation = buildConversation();
    conversation.turns[0]!.diff = buildMultiFilePatch(2);
    const scrollTargets: string[] = [];
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function scrollIntoViewForTest() {
      const reviewPath = this.getAttribute("data-review-path");
      if (reviewPath) scrollTargets.push(reviewPath);
    };

    try {
      const view = render(
        <NodexTooltipProvider>
          <ReviewDiffPanel
            conversation={conversation}
            projectWorkspacePath="/tmp/codex"
            initialFileTreeOpen
          />
        </NodexTooltipProvider>,
      );

      await settleAsyncRender();
      const fileRow = await waitForReviewTreePath(view.container, "src/file-002.ts");
      fireEvent.click(fileRow);

      await waitFor(() => {
        expect(scrollTargets).toContain("src/file-002.ts");
      });
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  test("hides the file tree without losing the selected diff", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();

    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel
          conversation={buildConversation()}
          projectWorkspacePath="/tmp/codex"
          initialFileTreeOpen
        />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();
    await waitForReviewTree(view.container);

    await dispatchReviewEvent(() => {
      fireEvent.click(view.getByLabelText("Hide files"));
    });

    expect(view.queryByPlaceholderText("Filter files…")).toBe(null);
    expect(view.container.querySelector('[data-file-diff="src/example.ts"]')).not.toBeNull();
  });

  test("virtualizes the review file tree with codex-style host attrs", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    mockInvokeImpl = async (channel: unknown) => {
      if (channel !== "review-diff") return null;
      return {
        cwd: "/tmp/storybook/virtualized-tree",
        source: "unstaged",
        patch: buildMultiFilePatch(24, true),
        files: [],
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
          projectWorkspacePath="/tmp/storybook/virtualized-tree"
          initialSource="unstaged"
          initialFileTreeOpen
        />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();
    await settleAsyncRender();
    await waitForReviewTree(view.container);
    await waitFor(() => {
      if (!view.container.querySelector('[data-file-tree-virtualized-root="true"]')) {
        throw new Error("Expected the review file tree to render the virtualized shell.");
      }
    });

    const virtualizedRoot = view.container.querySelector(
      '[data-file-tree-virtualized-root="true"]',
    );
    const virtualizedScroll = view.container.querySelector(
      '[data-file-tree-virtualized-scroll="true"]',
    );
    const virtualizedList = view.container.querySelector(
      '[data-file-tree-virtualized-list="true"]',
    );
    if (!virtualizedRoot || !virtualizedScroll || !virtualizedList) {
      throw new Error("Expected the review file tree to render the virtualized shell.");
    }

    const renderedTreeRows = view.container.querySelectorAll('[data-review-tree-item="true"]');
    expect(renderedTreeRows.length < 24).toBe(true);
  });

  test("collapses and expands folder rows in the review file tree", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();

    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel
          conversation={buildConversation()}
          projectWorkspacePath="/tmp/codex"
          initialFileTreeOpen
        />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();

    const folderRow = await waitForReviewTreePath(view.container, "src");
    await dispatchReviewEvent(() => {
      fireEvent.click(folderRow);
    });
    const collapsedTreeRows = Array.from(
      view.container.querySelectorAll('[data-review-tree-item="true"]'),
    );
    expect(
      collapsedTreeRows.some(
        (node) => node.getAttribute("data-review-tree-path") === "src/example.ts",
      ),
    ).toBe(false);

    await dispatchReviewEvent(() => {
      fireEvent.click(folderRow);
    });
    const expandedTreeRows = Array.from(
      view.container.querySelectorAll('[data-review-tree-item="true"]'),
    );
    expect(
      expandedTreeRows.some(
        (node) => node.getAttribute("data-review-tree-path") === "src/example.ts",
      ),
    ).toBe(true);
  });

  test("tracks folder selection and focus with tree item ids", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();

    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel
          conversation={buildConversation()}
          projectWorkspacePath="/tmp/codex"
          initialFileTreeOpen
        />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();

    const folderRow = await waitForReviewTreePath(view.container, "src");

    await dispatchReviewEvent(() => {
      fireEvent.click(folderRow);
    });

    expect(folderRow.getAttribute("data-item-selected")).toBe("true");
    expect(folderRow.getAttribute("data-item-focused")).toBe("true");
  });

  test("keeps folder change metadata without rendering modified status markers", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    mockInvokeImpl = async (channel: unknown) => {
      if (channel !== "review-diff") return null;
      return {
        cwd: "/tmp/storybook/status-tree",
        source: "unstaged",
        patch:
          "diff --git a/src/workbench.tsx b/src/workbench.tsx\nindex 1111111..2222222 100644\n--- a/src/workbench.tsx\n+++ b/src/workbench.tsx\n@@ -1 +1,2 @@\n export const workbench = true;\n+export const status = 'modified';\n",
        files: [buildGitSummary("src/workbench.tsx", "modified")],
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
          projectWorkspacePath="/tmp/storybook/status-tree"
          initialSource="unstaged"
          initialFileTreeOpen
        />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();
    await settleAsyncRender();

    const folderRow = await waitForReviewTreePath(view.container, "src");
    const fileRow = await waitForReviewTreePath(view.container, "src/workbench.tsx");

    expect(folderRow.getAttribute("data-item-contains-git-change")).toBe("true");
    expect(folderRow.querySelector('[data-item-section="git"]')).toBe(null);
    expect(fileRow.querySelector('[data-item-section="git"]')).toBe(null);
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

  test("renders A/D markers for added and deleted files", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    mockInvokeImpl = async (channel: unknown) => {
      if (channel !== "review-diff") return null;
      return {
        cwd: "/tmp/storybook/status-tree",
        source: "unstaged",
        patch: [
          "diff --git a/src/added.ts b/src/added.ts",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/src/added.ts",
          "@@ -0,0 +1 @@",
          "+export const added = true;",
          "",
          "diff --git a/src/deleted.ts b/src/deleted.ts",
          "deleted file mode 100644",
          "--- a/src/deleted.ts",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-export const deleted = true;",
          "",
        ].join("\n"),
        files: [
          buildGitSummary("src/added.ts", "added"),
          buildGitSummary("src/deleted.ts", "deleted"),
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
          projectWorkspacePath="/tmp/storybook/status-tree"
          initialSource="unstaged"
          initialFileTreeOpen
        />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();
    await settleAsyncRender();
    await waitForReviewTreePath(view.container, "src/added.ts");
    await waitForReviewTreePath(view.container, "src/deleted.ts");

    const addedStatus = view.container.querySelector(
      '[data-item-type="file"][data-review-tree-path="src/added.ts"] [data-item-section="git"]',
    );
    const deletedStatus = view.container.querySelector(
      '[data-item-type="file"][data-review-tree-path="src/deleted.ts"] [data-item-section="git"]',
    );
    if (!addedStatus || !deletedStatus) {
      throw new Error("Expected added and deleted file status slots.");
    }

    expect((addedStatus.textContent ?? "").trim()).toBe("A");
    expect((deletedStatus.textContent ?? "").trim()).toBe("D");
  });

  test("switches review source without starting a protocol review", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    mockInvokeImpl = async (channel: unknown) => {
      if (channel !== "review-diff") return null;
      return {
        cwd: "/tmp/codex",
        source: "unstaged",
        patch:
          "diff --git a/src/git.ts b/src/git.ts\nindex 1111111..2222222 100644\n--- a/src/git.ts\n+++ b/src/git.ts\n@@ -1 +1,2 @@\n export const git = 1;\n+export const diff = true;\n",
        files: [],
        isGitRepository: true,
        baseRef: null,
        currentBranch: "feature",
        defaultBranch: "main",
        errorMessage: null,
      };
    };

    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel conversation={buildConversation()} projectWorkspacePath="/tmp/codex" />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();
    await act(async () => {
      fireEvent.mouseDown(view.getByLabelText("Review source"), {
        button: 0,
        ctrlKey: false,
      });
      await Promise.resolve();
    });
    await settleAsyncRender();
    const menuText = textContent(view.baseElement);
    expect(menuText.includes("Unstaged")).toBe(true);
    expect(menuText.includes("Staged")).toBe(true);
    expect(menuText.includes("Commit")).toBe(true);
    expect(menuText.includes("Branch")).toBe(true);
    expect(menuText.includes("Last turn")).toBe(true);
    expect(menuText.includes("Review uncommitted changes")).toBe(false);
    const unstagedItem = await waitForMenuItem(view.baseElement as HTMLElement, "Unstaged");
    await clickReviewMenuItem(unstagedItem);

    await waitForGitReviewSnapshotCall();
    expect(invokeCalls.some((call) => call[0] === "review-diff")).toBe(true);
    expect(invokeCalls.some((call) => call[0] === "codex:review:start")).toBe(false);
    await unmountReviewView(view);
  });

  test("renders Codex staged empty state and switches to branch diff from its action", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    mockInvokeImpl = async (channel: unknown, input: unknown) => {
      if (channel !== "review-diff") return null;
      const source =
        typeof input === "object" && input !== null && "source" in input
          ? (input as { source?: string }).source
          : "staged";
      return {
        cwd: "/tmp/codex",
        source,
        patch: "",
        files: [],
        isGitRepository: true,
        baseRef: source === "branch" ? "main" : null,
        currentBranch: "feature",
        defaultBranch: "main",
        errorMessage: null,
      };
    };

    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel
          conversation={buildConversation()}
          projectWorkspacePath="/tmp/codex"
          initialSource="staged"
          initialFileTreeOpen
        />
      </NodexTooltipProvider>,
    );

    await waitForGitReviewSnapshotCall();
    await settleAsyncRender();

    expect(textContent(view.container).includes("No staged changes")).toBe(true);
    expect(textContent(view.container).includes("Accept edits to stage them")).toBe(true);
    expect(textContent(view.container).includes("View branch diff")).toBe(true);
    expect(view.getByPlaceholderText("Filter files…").getAttribute("placeholder")).toBe(
      "Filter files…",
    );
    expect(textContent(view.container).includes("No matching files")).toBe(true);

    await dispatchReviewEvent(() => {
      fireEvent.click(view.getByText("View branch diff"));
    });
    await waitFor(() => {
      const hasBranchDiffRequest = invokeCalls.some((call) => {
        if (call[0] !== "review-summary") return false;
        const input = call[1];
        return (
          typeof input === "object" &&
          input !== null &&
          "source" in input &&
          (input as { source?: unknown }).source === "branch"
        );
      });
      if (!hasBranchDiffRequest) {
        throw new Error("Expected branch review snapshot request.");
      }
    });

    expect(invokeCalls.some((call) => call[0] === "codex:review:start")).toBe(false);
  });

  test("renders Codex unstaged empty state copy", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    mockInvokeImpl = async (channel: unknown, input: unknown) => {
      if (channel !== "review-diff") return null;
      const source =
        typeof input === "object" && input !== null && "source" in input
          ? (input as { source?: string }).source
          : "unstaged";
      return {
        cwd: "/tmp/codex",
        source,
        patch: "",
        files: [],
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
          projectWorkspacePath="/tmp/codex"
          initialSource="unstaged"
        />
      </NodexTooltipProvider>,
    );

    await waitForGitReviewSnapshotCall();
    await settleAsyncRender();

    expect(textContent(view.container).includes("No unstaged changes")).toBe(true);
    expect(textContent(view.container).includes("Code changes will appear here")).toBe(true);
    expect(textContent(view.container).includes("View branch diff")).toBe(true);
    expect(textContent(view.container).includes("The latest diffs are no longer available.")).toBe(
      false,
    );
  });

  test("renders Codex last-turn committed-or-reverted empty state when a stale diff has no files", async () => {
    const conversation = buildConversation();
    conversation.turns[0]!.diff = "diff payload retained but no renderable file entries";

    const view = render(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <ReviewDiffPanel
            conversationProjection={buildReviewConversationProjection(conversation)}
            onStartThreadPrompt={recordStartThreadPrompt}
            projectWorkspacePath="/tmp/codex"
            deps={{
              ...reviewDiffPanelTestDeps,
              parsePatchFiles: () => [],
            }}
          />
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );

    await settleAsyncRender();

    expect(textContent(view.container).includes("No file changes yet")).toBe(true);
    expect(textContent(view.container).includes("The last turn was committed or reverted.")).toBe(
      true,
    );
    expect(textContent(view.container).includes("The latest diffs are no longer available.")).toBe(
      false,
    );
    expect(textContent(view.container).includes("Changes in this project will appear here.")).toBe(
      false,
    );
    expect(textContent(view.container).includes("View branch diff")).toBe(true);
  });

  test("keeps Codex latest-unavailable copy when last-turn has no diff payload", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const conversation = buildConversation();
    conversation.turns[0]!.diff = "";

    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel conversation={conversation} projectWorkspacePath="/tmp/codex" />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();

    expect(textContent(view.container).includes("No file changes yet")).toBe(true);
    expect(textContent(view.container).includes("The latest diffs are no longer available.")).toBe(
      true,
    );
    expect(textContent(view.container).includes("The last turn was committed or reverted.")).toBe(
      false,
    );
  });

  test("prefers the explicit project workspace path for git-backed review sources", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    mockInvokeImpl = async (channel: unknown, payload: unknown) => {
      if (channel !== "review-diff") return null;
      const cwd =
        typeof payload === "object" && payload !== null && "cwd" in payload
          ? (payload as { cwd: string }).cwd
          : "";
      return {
        cwd,
        source: "unstaged",
        patch: "",
        files: [],
        isGitRepository: true,
        baseRef: null,
        currentBranch: "feature",
        defaultBranch: "main",
        errorMessage: null,
      };
    };

    render(
      <NodexTooltipProvider>
        <ReviewDiffPanel
          conversation={buildConversation()}
          projectWorkspacePath="/tmp/storybook/large-diff"
          initialSource="unstaged"
        />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();
    await waitForGitReviewSnapshotCall();

    const snapshotCall = invokeCalls.find((call) => call[0] === "review-summary");
    if (!snapshotCall) {
      throw new Error("Expected git-backed review to request a snapshot.");
    }
    const payload = snapshotCall[1];
    const cwd =
      typeof payload === "object" && payload !== null && "cwd" in payload
        ? (payload as { cwd: string }).cwd
        : "";
    expect(cwd).toBe("/tmp/storybook/large-diff");
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

  test("subscribes summary and repository metadata through typed live queries", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const subscriptions: Array<{
      subscriptionId: string;
      query: { method: string; params: { cwd: string } };
    }> = [];
    mockInvokeImpl = async (channel: unknown, payload: unknown) => {
      if (channel === "stable-metadata") {
        return {
          cwd: "/tmp/codex",
          root: "/tmp/codex",
          gitDir: "/tmp/codex/.git",
          commonDir: "/tmp/codex/.git",
          isGitRepository: true,
          currentBranch: "feature/live-query",
          defaultBranch: "main",
          errorMessage: null,
        };
      }
      if (
        channel === "subscribe-live-query" &&
        typeof payload === "object" &&
        payload !== null &&
        "subscriptionId" in payload &&
        "query" in payload
      ) {
        subscriptions.push(payload as (typeof subscriptions)[number]);
      }
      return null;
    };

    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel
          conversation={buildConversation()}
          projectWorkspacePath="/tmp/codex"
          initialSource="unstaged"
          deps={{ initialSummaryQuery: false }}
        />
      </NodexTooltipProvider>,
    );

    await waitFor(() => {
      expect(subscriptions.map(({ query }) => query.method).sort()).toEqual([
        "base-branch",
        "review-summary",
        "stable-metadata",
      ]);
    });
    expect(subscriptions.every(({ query }) => query.params.cwd === "/tmp/codex")).toBe(true);
    await unmountReviewView(view);
  });

  test("uses the live remote base branch for branch review summaries", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const subscriptions: Array<{
      subscriptionId: string;
      query: {
        method: string;
        params: { cwd: string; baseBranch?: string | null };
      };
    }> = [];
    let publish: ((event: GitReviewLiveEvent) => void) | null = null;
    mockInvokeImpl = async (channel: unknown, payload: unknown) => {
      if (channel === "stable-metadata") {
        return {
          cwd: "/tmp/codex/alias",
          root: "/tmp/codex",
          gitDir: "/tmp/codex/.git",
          commonDir: "/tmp/codex/.git",
          isGitRepository: true,
          currentBranch: "feature/live-query",
          defaultBranch: "main",
          errorMessage: null,
        };
      }
      if (
        channel === "subscribe-live-query" &&
        typeof payload === "object" &&
        payload !== null &&
        "subscriptionId" in payload &&
        "query" in payload
      ) {
        subscriptions.push(payload as (typeof subscriptions)[number]);
      }
      return null;
    };

    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel
          conversation={buildConversation()}
          projectWorkspacePath="/tmp/codex/alias"
          initialSource="branch"
          deps={{
            initialSummaryQuery: false,
            gitWorkerClient: createReviewGitWorkerTestClientWithLiveEvents((listener) => {
              publish = listener;
            }),
          }}
        />
      </NodexTooltipProvider>,
    );

    let baseSubscriptionId = "";
    await waitFor(() => {
      const baseSubscription = subscriptions.find(({ query }) => query.method === "base-branch");
      if (!baseSubscription || !publish) {
        throw new Error("Expected the live base-branch subscription.");
      }
      baseSubscriptionId = baseSubscription.subscriptionId;
      expect(subscriptions.some(({ query }) => query.method === "review-summary")).toBe(false);
    });

    await act(async () => {
      publish?.({
        type: "git-live-query-updated",
        subscriptionId: baseSubscriptionId,
        generation: 1,
        requiresRecovery: false,
        phase: "complete",
        method: "base-branch",
        result: {
          cwd: "/tmp/codex",
          local: "main",
          remote: "origin/main",
          errorMessage: null,
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      const summarySubscription = subscriptions.find(
        ({ query }) => query.method === "review-summary",
      );
      expect(summarySubscription?.query.params).toMatchObject({
        cwd: "/tmp/codex",
        baseBranch: "origin/main",
      });
    });
    await unmountReviewView(view);
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

  test("preserves loaded rows and parsed metadata across tracked to complete publication", async () => {
    const intersectionObserver = installControlledIntersectionObserver();
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const trackedPatch = [
      "diff --git a/src/tracked.ts b/src/tracked.ts",
      "index 1111111..2222222 100644",
      "--- a/src/tracked.ts",
      "+++ b/src/tracked.ts",
      "@@ -1 +1,2 @@",
      " export const tracked = 1;",
      "+export const changed = true;",
      "",
    ].join("\n");
    const untrackedPatch = [
      "diff --git a/src/untracked.ts b/src/untracked.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/untracked.ts",
      "@@ -0,0 +1 @@",
      "+export const untracked = true;",
      "",
    ].join("\n");
    const trackedSummary = {
      ...buildGitSummary("src/tracked.ts"),
      generated: false,
    };
    const untrackedSummary = {
      ...buildGitSummary("src/untracked.ts", "untracked"),
      generated: false,
    };
    let publish: ((event: GitReviewLiveEvent) => void) | null = null;
    let subscriptionId = "";
    const events: Array<
      { type: "row-render"; path: string } | { type: "partial-parse"; path: string }
    > = [];
    const uninstallProbe = installReviewRuntimeProbe((event) => {
      if (event.type === "row-render" || event.type === "partial-parse") {
        events.push(event);
      }
    });

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
      const patch = requestedPaths
        .flatMap((path) => {
          if (path === trackedSummary.path) return [trackedPatch];
          if (path === untrackedSummary.path) return [untrackedPatch];
          return [];
        })
        .join("\n");
      return buildGitDiffResultForTest({
        patch,
        files: requestedPaths.flatMap((path) => {
          if (path === trackedSummary.path) return [trackedSummary];
          if (path === untrackedSummary.path) return [untrackedSummary];
          return [];
        }),
      });
    };

    try {
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
        expect(view.container.querySelector('[data-file-diff="src/tracked.ts"]')).not.toBeNull();
      });
      await settleAsyncRender();

      const trackedRenderCount = events.filter(
        (event) => event.type === "row-render" && event.path === trackedSummary.path,
      ).length;
      const trackedParseCount = events.filter(
        (event) => event.type === "partial-parse" && event.path === trackedSummary.path,
      ).length;

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
        expect(view.container.querySelector('[data-file-diff="src/untracked.ts"]')).not.toBeNull();
      });
      await settleAsyncRender();

      expect(
        events.filter((event) => event.type === "row-render" && event.path === trackedSummary.path),
      ).toHaveLength(trackedRenderCount);
      expect(
        events.filter(
          (event) => event.type === "partial-parse" && event.path === trackedSummary.path,
        ),
      ).toHaveLength(trackedParseCount);
      expect(trackedParseCount).toBe(1);

      const diffCallCount = invokeCalls.filter(([channel]) => channel === "review-diff").length;
      const totalParseCount = events.filter((event) => event.type === "partial-parse").length;
      await act(async () => {
        publish?.({
          type: "git-live-query-updated",
          subscriptionId,
          generation: 2,
          requiresRecovery: false,
          phase: "complete",
          method: "review-summary",
          result: {
            type: "success",
            source: "unstaged",
            files: [{ ...trackedSummary }, { ...untrackedSummary }],
            snapshotGeneration: 2,
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
      await settleAsyncRender();

      expect(invokeCalls.filter(([channel]) => channel === "review-diff")).toHaveLength(
        diffCallCount,
      );
      expect(events.filter((event) => event.type === "partial-parse")).toHaveLength(
        totalParseCount,
      );
    } finally {
      uninstallProbe();
      intersectionObserver.restore();
    }
  });

  test("rerenders only the row whose pending review comments changed", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const conversation = buildConversation();
    conversation.turns[0]!.diff = buildMultiFilePatch(2);
    const rowRenders: string[] = [];
    const uninstallProbe = installReviewRuntimeProbe((event) => {
      if (event.type === "row-render") rowRenders.push(event.path);
    });

    try {
      render(
        <NodexTooltipProvider>
          <ReviewDiffPanel conversation={conversation} />
        </NodexTooltipProvider>,
      );
      await waitFor(() => {
        expect(rowRenders).toContain("src/file-001.ts");
        expect(rowRenders).toContain("src/file-002.ts");
      });
      await settleAsyncRender();
      rowRenders.length = 0;

      await act(async () => {
        addReviewDiffCommentAttachment("thr_review", {
          id: "comment:file-001",
          type: "comment",
          content: [{ content_type: "text", text: "Please revise this line." }],
          position: {
            side: "right",
            path: "src/file-001.ts",
            line: 2,
          },
          createdAt: 1,
        });
        await Promise.resolve();
      });

      await waitFor(() => expect(rowRenders).toContain("src/file-001.ts"));
      expect(rowRenders).not.toContain("src/file-002.ts");
    } finally {
      uninstallProbe();
    }
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

  test("starts commit and pull-request prompts from the parity action buttons", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    mockInvokeImpl = async (channel: unknown) => {
      if (channel === "review-diff") {
        return {
          cwd: "/tmp/codex",
          source: "unstaged",
          patch:
            "diff --git a/src/git.ts b/src/git.ts\nindex 1111111..2222222 100644\n--- a/src/git.ts\n+++ b/src/git.ts\n@@ -1 +1,2 @@\n export const git = 1;\n+export const diff = true;\n",
          files: [],
          isGitRepository: true,
          baseRef: null,
          currentBranch: "feature",
          defaultBranch: "main",
          errorMessage: null,
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
        />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();
    await waitForGitReviewDiffCall();
    await waitFor(() => {
      if (view.getByLabelText("Commit or push").hasAttribute("disabled")) {
        throw new Error("Expected Commit or push to become enabled.");
      }
      if (view.getByLabelText("Create PR").hasAttribute("disabled")) {
        throw new Error("Expected Create PR to become enabled.");
      }
    });
    await dispatchReviewEvent(() => {
      fireEvent.click(view.getByLabelText("Commit or push"));
    });
    await waitFor(() => {
      if (!startThreadPromptCalls.some((call) => call.prompt.includes("Commit or push"))) {
        throw new Error("Expected commit prompt turn to start.");
      }
    });

    await dispatchReviewEvent(() => {
      fireEvent.click(view.getByLabelText("Create PR"));
    });
    await waitFor(() => {
      if (!startThreadPromptCalls.some((call) => call.prompt.includes("pull request"))) {
        throw new Error("Expected pull request prompt turn to start.");
      }
    });

    expect(startThreadPromptCalls).toHaveLength(2);
    expect(startThreadPromptCalls[0]?.threadId).toBe("thr_review");
    expect(startThreadPromptCalls[0]?.prompt.includes("Commit or push")).toBe(true);
    expect(startThreadPromptCalls[1]?.threadId).toBe("thr_review");
    expect(startThreadPromptCalls[1]?.prompt.includes("pull request")).toBe(true);
  });

  test("renders review option states and diff toggle actions", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    mockInvokeImpl = async (channel: unknown) => {
      if (channel !== "review-diff") return null;
      return {
        cwd: "/tmp/codex",
        source: "unstaged",
        patch:
          "diff --git a/src/git.ts b/src/git.ts\nindex 1111111..2222222 100644\n--- a/src/git.ts\n+++ b/src/git.ts\n@@ -1 +1,2 @@\n export const git = 1;\n+export const diff = true;\n",
        files: [],
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
          projectWorkspacePath="/tmp/codex"
          initialSource="unstaged"
        />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();
    await waitForGitReviewDiffCall();
    await openReviewOptionsMenu(view);
    await waitFor(() => {
      const menuItems = Array.from(
        view.baseElement.ownerDocument.querySelectorAll('[role="menuitem"]'),
      );
      if (menuItems.length !== 7) {
        throw new Error("Expected review option rows to render.");
      }
    });

    const menuItems = Array.from(
      view.baseElement.ownerDocument.querySelectorAll('[role="menuitem"]'),
    ) as HTMLElement[];
    const optionLabels = menuItems.map((node) => (node.textContent ?? "").trim());

    expect(optionLabels.join("|")).toBe(
      "Refresh|Enable word wrap|Don't load full files|Enable rich preview|Disable word diffs|Hide white space|Copy git apply command",
    );
    expect(menuItems.some((node) => node.textContent?.includes("Review uncommitted changes"))).toBe(
      false,
    );
    expect(
      menuItems.some((node) => node.textContent?.includes("Review against a base branch")),
    ).toBe(false);
    expect(menuItems.some((node) => node.textContent?.includes("Wrap lines"))).toBe(false);
    expect(menuItems.some((node) => node.textContent?.includes("Hide whitespace"))).toBe(false);
    expect(menuItems.some((node) => node.textContent?.includes("Unified"))).toBe(false);
    expect(view.getByLabelText("Switch to split diff").tagName).toBe("BUTTON");
    expect(view.getByLabelText("Collapse all diffs").tagName).toBe("BUTTON");
    await unmountReviewView(view);
  });

  test("keeps virtualized FileDiff instances mounted while collapsing all rows", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const conversation = buildConversation();
    conversation.turns[0]!.diff = buildMultiFilePatch(3);
    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel conversation={conversation} projectWorkspacePath="/tmp/codex" />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();
    expect(view.container.querySelectorAll("[data-file-diff]")).toHaveLength(3);
    expect(
      Array.from(view.container.querySelectorAll("[data-file-diff]")).every(
        (node) => node.getAttribute("data-collapsed") === "false",
      ),
    ).toBe(true);

    await dispatchReviewEvent(() => {
      fireEvent.click(view.getByLabelText("Collapse all diffs"));
    });
    await waitFor(() => {
      expect(view.getByLabelText("Expand all diffs").tagName).toBe("BUTTON");
      expect(view.container.querySelectorAll("[data-file-diff]")).toHaveLength(3);
      expect(
        Array.from(view.container.querySelectorAll("[data-file-diff]")).every(
          (node) => node.getAttribute("data-collapsed") === "true",
        ),
      ).toBe(true);
    });

    await dispatchReviewEvent(() => {
      fireEvent.click(view.getAllByLabelText("Toggle file diff")[0]!);
    });
    await waitFor(() => {
      const diffHosts = Array.from(view.container.querySelectorAll("[data-file-diff]"));
      expect(diffHosts.map((node) => node.getAttribute("data-collapsed"))).toEqual([
        "false",
        "true",
        "true",
      ]);
      expect(view.getByLabelText("Expand all diffs").tagName).toBe("BUTTON");
    });

    await unmountReviewView(view);
  });

  test("passes native wrap overflow to FileDiff after enabling word wrap", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel conversation={buildConversation()} projectWorkspacePath="/tmp/codex" />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();
    expect((lastFileDiffProps?.options as { overflow?: string } | undefined)?.overflow).toBe(
      "scroll",
    );
    await openReviewOptionsMenu(view);
    const wrapItem = Array.from(
      view.baseElement.ownerDocument.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.includes("Enable word wrap"));
    if (!wrapItem) throw new Error("Expected the word-wrap Review option.");
    await clickReviewMenuItem(wrapItem);

    await waitFor(() => {
      const overflow = (lastFileDiffProps?.options as { overflow?: string } | undefined)?.overflow;
      if (overflow !== "wrap") {
        throw new Error("Expected Review to pass native wrap overflow to FileDiff.");
      }
    });
    await unmountReviewView(view);
  });

  test("copies the git apply command from the review options menu", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const patch =
      "diff --git a/src/git.ts b/src/git.ts\nindex 1111111..2222222 100644\n--- a/src/git.ts\n+++ b/src/git.ts\n@@ -1 +1,2 @@\n export const git = 1;\n+export const diff = true;\n";
    mockInvokeImpl = async (channel: unknown) => {
      if (channel === "review-patch") {
        return {
          cwd: "/tmp/codex",
          source: "unstaged",
          diff: {
            type: "success",
            unifiedDiff: patch,
            unifiedDiffBytes: patch.length,
          },
          isGitRepository: true,
          baseRef: null,
          currentBranch: "feature",
          defaultBranch: "main",
          errorMessage: null,
        };
      }
      if (channel !== "review-diff") return null;
      return {
        cwd: "/tmp/codex",
        source: "unstaged",
        patch,
        files: [],
        isGitRepository: true,
        baseRef: null,
        currentBranch: "feature",
        defaultBranch: "main",
        errorMessage: null,
      };
    };

    const view = render(
      <NodexToastProvider>
        <NodexTooltipProvider>
          <ReviewDiffPanel
            conversation={buildConversation()}
            projectWorkspacePath="/tmp/codex"
            initialSource="unstaged"
          />
        </NodexTooltipProvider>
      </NodexToastProvider>,
    );

    await settleAsyncRender();
    await waitForGitReviewSnapshotCall();
    await openReviewOptionsMenu(view);
    await clickReviewMenuItem(await waitForMenuItem(view.baseElement, "Copy git apply command"));
    await waitForGitReviewPatchCall();

    expect(clipboardWrites.length).toBe(1);
    const copiedCommand = clipboardWrites[0] ?? "";
    expect(
      copiedCommand.startsWith(
        " (cd \"$(git rev-parse --show-toplevel)\" && git apply --3way <<'EOF'",
      ),
    ).toBe(true);
    expect(copiedCommand.includes("diff --git a/src/git.ts b/src/git.ts")).toBe(true);
    expect(copiedCommand.endsWith("EOF\n)")).toBe(true);
    await unmountReviewView(view);
  });

  test("jump-to-file filters and selects a diff row", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    mockInvokeImpl = async (channel: unknown) => {
      if (channel === "review-diff") {
        return {
          cwd: "/tmp/codex",
          source: "unstaged",
          patch: buildMultiFilePatch(3),
          files: [],
          isGitRepository: true,
          baseRef: null,
          currentBranch: "feature",
          defaultBranch: "main",
          errorMessage: null,
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
        />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();
    await settleAsyncRender();

    await dispatchReviewEvent(() => {
      fireEvent.mouseDown(view.getByLabelText("Jump to file"), {
        button: 0,
        ctrlKey: false,
      });
    });
    const jumpInput = view.baseElement.ownerDocument.querySelector(
      'input[aria-label="Jump to file"]',
    );
    if (!isDomElement(jumpInput)) {
      throw new Error("Expected jump-to-file input.");
    }
    await dispatchReviewEvent(() => {
      fireEvent.input(jumpInput, {
        target: { value: "file-003" },
      });
    });
    const fileItem = await waitForMenuItem(view.baseElement as HTMLElement, "file-003.ts");
    const fileItemText = textContent(fileItem);
    expect(fileItemText.includes("file-003.ts")).toBe(true);
    expect(fileItemText.includes("src")).toBe(true);
    expect(fileItem.querySelector(".text-token-description-foreground")?.textContent).toBe("src");
    await dispatchReviewEvent(() => {
      fireEvent.click(fileItem);
    });

    expect(view.container.querySelector('[data-review-path="src/file-003.ts"]')).not.toBeNull();
    await settleAsyncRender();
    await settleAsyncRender();
    await unmountReviewView(view);
  });

  test("shows the codex large-diff banner in capped mode", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();

    const manyDiffLines = Array.from({ length: 9_100 }, (_, index) => `+line ${index}`).join("\n");
    const conversation = {
      ...buildConversation(),
      turns: [
        {
          ...buildConversation().turns[0]!,
          diff: `diff --git a/src/large.ts b/src/large.ts\nindex 1111111..2222222 100644\n--- a/src/large.ts\n+++ b/src/large.ts\n@@ -0,0 +1,9100 @@\n${manyDiffLines}\n`,
        },
      ],
    } satisfies CodexConversationSnapshot;

    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel conversation={conversation} projectWorkspacePath="/tmp/codex" />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();

    expect(
      textContent(view.container).includes("This diff is large, showing one file at a time"),
    ).toBe(true);
  });

  test("renders code-comment directives as anchored review annotations", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();
    const conversation = buildConversation();
    conversation.turns[0]!.items = [
      {
        threadId: "thr_review",
        turnId: "turn_1",
        itemId: "item_comment",
        type: "message",
        kind: "assistantMessage",
        role: "assistant",
        markdownText:
          '::code-comment{title="Check value" body="This line needs a stronger invariant." file="src/example.ts" start=2 end=2 priority=1}',
        createdAt: 1,
        updatedAt: 1,
      },
    ];

    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel conversation={conversation} projectWorkspacePath="/tmp/codex" />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();

    expect(textContent(view.container).includes("Check value")).toBe(true);
    expect(textContent(view.container).includes("Comment on line R2")).toBe(true);
    expect(view.container.querySelector('[data-review-code-comments="true"]') === null).toBe(true);
    expect(
      view.container.querySelector('[data-rendered-line-annotation="additions:2"]'),
    ).not.toBeNull();
  });

  test("creates a local comment draft from the diff gutter utility callback", async () => {
    const { ReviewDiffPanel } = await loadReviewDiffPanelModule();

    const view = render(
      <NodexTooltipProvider>
        <ReviewDiffPanel conversation={buildConversation()} projectWorkspacePath="/tmp/codex" />
      </NodexTooltipProvider>,
    );

    await settleAsyncRender();

    expect(lastFileDiffProps?.options).not.toBeNull();
    await act(async () => {
      (
        lastFileDiffProps?.options as {
          onLineSelectionChange?: (range: {
            side: "additions";
            start: number;
            end: number;
          }) => void;
        }
      )?.onLineSelectionChange?.({ side: "additions", start: 2, end: 2 });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      view.container.querySelector("[data-file-diff]")?.getAttribute("data-selected-lines"),
    ).toBe("additions:2-:2");

    await act(async () => {
      (
        lastFileDiffProps?.options as {
          onGutterUtilityClick?: (range: { side: "additions"; start: number; end: number }) => void;
        }
      )?.onGutterUtilityClick?.({ side: "additions", start: 2, end: 2 });
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(textContent(view.container).includes("Local comment")).toBe(true);
    expect(textContent(view.container).includes("Comment on line R2")).toBe(true);
    expect(view.container.querySelector('[data-placeholder="Request change"]')).not.toBeNull();
    expect(textContent(view.container).includes("Cancel")).toBe(true);
    expect(textContent(view.container).includes("Comment")).toBe(true);
    expect(
      view.container.querySelector("[data-file-diff]")?.getAttribute("data-selected-lines"),
    ).toBe("");
  });
});
