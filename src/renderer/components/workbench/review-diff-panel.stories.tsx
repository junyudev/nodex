import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useMemo, useReducer, useRef, type ComponentProps } from "react";
import type {
  CodexConversationSnapshot,
  CodexReviewDiffCommentAttachment,
  GitReviewFileSummary,
  GitReviewLiveEvent,
  GitReviewLiveSubscriptionInput,
  GitReviewSource,
  ReviewDiffEntry,
} from "@/lib/types";
import {
  addReviewDiffCommentAttachment,
  clearReviewDiffCommentAttachments,
} from "@/lib/review-diff-comment-attachment-store";
import { buildReviewFileSafety } from "../../../shared/review-file-safety";
import { ReviewDiffPanel } from "./review-diff-panel";
import { buildReviewConversationProjection } from "@/features/review/model/review-conversation-projection";
import { WorkbenchSessionScopePath } from "@/lib/workbench-ui-scopes";

function buildStoryConversation(): CodexConversationSnapshot {
  return {
    threadId: "thr_story_review",
    projectId: "default",
    source: null,
    threadName: "Review thread",
    threadPreview: "Inspect the latest turn diff",
    modelProvider: "codex",
    cwd: "/Users/asc/repo/nodex",
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    linkedAt: "2026-03-01T00:00:00.000Z",
    resumeState: "resumed",
    turns: [
      {
        threadId: "thr_story_review",
        turnId: "turn_1",
        status: "completed",
        diff: [
          "diff --git a/src/renderer/components/workbench/workbench-shell.tsx b/src/renderer/components/workbench/workbench-shell.tsx",
          "index 1111111..2222222 100644",
          "--- a/src/renderer/components/workbench/workbench-shell.tsx",
          "+++ b/src/renderer/components/workbench/workbench-shell.tsx",
          "@@ -1768,6 +1768,10 @@",
          '       title: "Diffs",',
          "       icon: STAGE_ICONS.files,",
          "       hideHeader: true,",
          "-      content: <StageFilesPlaceholder />,",
          "+      content: (",
          "+        <ReviewDiffPanel conversation={activeThreadConversation} />",
          "+      ),",
          "     },",
          "",
          "diff --git a/src/renderer/components/workbench/review-diff-panel.tsx b/src/renderer/components/workbench/review-diff-panel.tsx",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/src/renderer/components/workbench/review-diff-panel.tsx",
          "@@ -0,0 +1,4 @@",
          "+export function ReviewDiffPanel() {",
          "+  return null;",
          "+}",
          "+",
          "",
        ].join("\n"),
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

function buildCommentStoryConversation(): CodexConversationSnapshot {
  const conversation = buildStoryConversation();
  conversation.turns[0]!.items = [
    {
      threadId: "thr_story_review",
      turnId: "turn_1",
      itemId: "item_review_comment",
      type: "message",
      kind: "assistantMessage",
      role: "assistant",
      markdownText:
        '::code-comment{title="Tighten guard" body="This branch should return early before the expensive path." file="src/renderer/components/workbench/workbench-shell.tsx" start=1768 end=1768 priority=1}',
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  return conversation;
}

function buildReviewParityConversation(): CodexConversationSnapshot {
  const conversation = buildStoryConversation();
  conversation.threadId = "thr_story_review_parity";
  conversation.turns[0] = {
    ...conversation.turns[0]!,
    threadId: "thr_story_review_parity",
    turnId: "turn_review_parity",
    diff: [
      "diff --git a/src/renderer/components/workbench/review-pane.tsx b/src/renderer/components/workbench/review-pane.tsx",
      "index 1111111..2222222 100644",
      "--- a/src/renderer/components/workbench/review-pane.tsx",
      "+++ b/src/renderer/components/workbench/review-pane.tsx",
      "@@ -1,4 +1,5 @@",
      ' import { useMemo } from "react";',
      " type Props = { open: boolean };",
      " export function ReviewPane(props: Props) {",
      "+  const active = props.open;",
      "   return null;",
      "@@ -120,4 +121,5 @@",
      " function renderFooter() {",
      '   const label = "Review";',
      '+  const action = "Inspect";',
      "   return label;",
      " }",
      "",
      "diff --git a/src/renderer/lib/review-model.ts b/src/renderer/lib/review-model.ts",
      "index 1111111..2222222 100644",
      "--- a/src/renderer/lib/review-model.ts",
      "+++ b/src/renderer/lib/review-model.ts",
      "@@ -12,4 +12,5 @@",
      " export type ReviewModel = {",
      "   path: string;",
      "+  iconToken: string;",
      " };",
      "@@ -80,5 +81,6 @@",
      " export function buildModel() {",
      "   return {",
      '+    iconToken: "typescript",',
      '     path: "src/renderer/lib/review-model.ts",',
      "   };",
      " }",
      "",
      "diff --git a/docs/FRONTEND.md b/docs/FRONTEND.md",
      "index 1111111..2222222 100644",
      "--- a/docs/FRONTEND.md",
      "+++ b/docs/FRONTEND.md",
      "@@ -1,4 +1,5 @@",
      " # Frontend",
      " Review tab surfaces are compact.",
      "+File rows use Codex file-type icons.",
      " ## Diff review",
      " Keep the diff readable.",
      "@@ -60,4 +61,5 @@",
      " ## Implementation notes",
      " Diff context should stay expandable.",
      "+Large unchanged ranges render line-info separators.",
      " Manual review covers visual parity.",
      " Tests cover behavior.",
      "",
    ].join("\n"),
  };
  return conversation;
}

function buildMetadataOnlyReviewConversation(input: {
  threadId: string;
  path: string;
  safety: ReturnType<typeof buildReviewFileSafety>;
}): CodexConversationSnapshot {
  const conversation = buildStoryConversation();
  conversation.threadId = input.threadId;
  conversation.turns[0] = {
    ...conversation.turns[0]!,
    threadId: input.threadId,
    turnId: "turn_metadata_only",
    diff: "",
    items: [
      {
        threadId: input.threadId,
        turnId: "turn_metadata_only",
        entryId: "turn-diff:turn_metadata_only",
        itemId: "turn-diff:turn_metadata_only",
        type: "turn_diff",
        kind: "systemEvent",
        semanticKind: "diff",
        status: "completed",
        source: "live",
        sequence: 0,
        rawItem: {
          type: "turn-diff",
          unifiedDiff: "",
          patchBatches: [
            {
              cwd: conversation.cwd,
              changes: [
                {
                  path: input.path,
                  type: "nonRenderable",
                  originalType: "add",
                  movePath: null,
                  safety: input.safety,
                },
              ],
            },
          ],
        },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
  return conversation;
}

type ReviewStorySurfaceProps = Omit<
  ComponentProps<typeof ReviewDiffPanel>,
  "conversationProjection"
> & {
  conversation?: CodexConversationSnapshot | null;
};

function ReviewStorySurface({
  openControlLabel,
  pendingCommentAttachments,
  conversation = null,
  ...args
}: ReviewStorySurfaceProps & {
  openControlLabel?: string;
  pendingCommentAttachments?: CodexReviewDiffCommentAttachment[];
}) {
  const conversationProjection = buildReviewConversationProjection(conversation);
  const storyThreadId = conversationProjection.threadId ?? args.threadId ?? null;

  useEffect(() => {
    if (!storyThreadId || !pendingCommentAttachments?.length) return;
    clearReviewDiffCommentAttachments(storyThreadId);
    for (const attachment of pendingCommentAttachments) {
      addReviewDiffCommentAttachment(storyThreadId, attachment);
    }
    return () => clearReviewDiffCommentAttachments(storyThreadId);
  }, [pendingCommentAttachments, storyThreadId]);

  useEffect(() => {
    if (!openControlLabel) return;
    const timerId = window.setTimeout(() => {
      const button = document.querySelector<HTMLButtonElement>(
        `button[aria-label="${openControlLabel}"]`,
      );
      button?.click();
    }, 100);
    return () => window.clearTimeout(timerId);
  }, [openControlLabel]);

  return (
    <WorkbenchSessionScopePath
      thread={{
        stableKey: "session:review-story",
        phase: "attached",
        projectSessionId: "review-story",
        clientThreadId: null,
        threadId: storyThreadId,
      }}
      route={{ routeKey: `/story/review/${storyThreadId ?? "empty"}`, kind: "thread" }}
      selected
    >
      <div className="h-screen overflow-hidden bg-token-main-surface-primary">
        <ReviewDiffPanel {...args} conversationProjection={conversationProjection} />
      </div>
    </WorkbenchSessionScopePath>
  );
}

function buildStoryPendingComment(input: {
  id: string;
  path: string;
  side: "left" | "right";
  line: number;
  startLine?: number;
  startSide?: "left" | "right";
  text: string;
}): CodexReviewDiffCommentAttachment {
  return {
    id: input.id,
    type: "comment",
    content: [
      {
        content_type: "text",
        text: input.text,
      },
    ],
    position: {
      side: input.side,
      path: input.path,
      line: input.line,
      ...(input.startLine ? { start_line: input.startLine } : {}),
      ...(input.startSide ? { start_side: input.startSide } : {}),
    },
    localDiffHunk:
      '@@ -1768,6 +1768,10 @@\n       title: "Diffs",\n+        <ReviewDiffPanel conversation={activeThreadConversation} />',
    source: {
      kind: "review-diff",
      label: "Comment on line R1771",
      sessionKey: "storybook",
    },
    createdAt: 1,
  };
}

type ReviewPanelDeps = NonNullable<ComponentProps<typeof ReviewDiffPanel>["deps"]>;
type ControlledReviewFixtureMode =
  | "live-publication"
  | "viewport-gating"
  | "full-content-fallbacks"
  | "stale-recovery";

const STORY_OLD_OID = "1".repeat(40);
const STORY_NEW_OID = "2".repeat(40);

function buildControlledReviewSummary(
  path: string,
  options?: {
    revision?: string;
    status?: GitReviewFileSummary["status"];
  },
): GitReviewFileSummary {
  const status = options?.status ?? "modified";
  return {
    path,
    previousPath: null,
    status,
    rawStatus: status === "untracked" ? "??" : " M",
    oldOid: status === "untracked" ? null : STORY_OLD_OID,
    newOid: status === "untracked" ? null : STORY_NEW_OID,
    revision: options?.revision ?? `story:${status}:${path}`,
    additions: 1,
    deletions: status === "untracked" ? 0 : 1,
    safety: buildReviewFileSafety(),
    generated: false,
  };
}

function buildControlledReviewPatch(file: GitReviewFileSummary): string {
  if (file.status === "untracked") {
    return [
      `diff --git a/${file.path} b/${file.path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${file.path}`,
      "@@ -0,0 +1 @@",
      `+export const ${file.path.replace(/[^a-z0-9]/gi, "_")} = true;`,
      "",
    ].join("\n");
  }

  return [
    `diff --git a/${file.path} b/${file.path}`,
    `index ${STORY_OLD_OID}..${STORY_NEW_OID} 100644`,
    `--- a/${file.path}`,
    `+++ b/${file.path}`,
    "@@ -1 +1 @@",
    `-export const value = "before:${file.path}";`,
    `+export const value = "after:${file.path}";`,
    "",
  ].join("\n");
}

function buildControlledReviewDiffEntry(file: GitReviewFileSummary): ReviewDiffEntry {
  const diff = buildControlledReviewPatch(file);
  return {
    ...file,
    diff,
    loadStatus: "loaded",
    renderKey: `${file.revision}:${diff.length}`,
    diffBytes: diff.length,
    diffError: null,
    canApplyPatchActions: true,
    changedBytes: diff.length,
    tooLarge: false,
    tooLargeReason: null,
  };
}

function buildControlledFixtureFiles(mode: ControlledReviewFixtureMode) {
  if (mode === "live-publication") {
    return [
      buildControlledReviewSummary("src/tracked-story.ts"),
      buildControlledReviewSummary("src/untracked-story.ts", {
        status: "untracked",
      }),
    ];
  }
  if (mode === "viewport-gating") {
    return Array.from({ length: 14 }, (_, index) =>
      buildControlledReviewSummary(`src/viewport/file-${String(index + 1).padStart(2, "0")}.ts`),
    );
  }
  if (mode === "full-content-fallbacks") {
    return ["loading", "success", "unavailable", "failed"].map((phase) =>
      buildControlledReviewSummary(`src/full-content/${phase}.ts`),
    );
  }
  return [
    buildControlledReviewSummary("src/stale-recovery.ts", {
      revision: "story:stale:1",
    }),
  ];
}

interface ControlledReviewTransport {
  deps: Pick<
    ReviewPanelDeps,
    | "gitWorkerClient"
    | "initialSummaryQuery"
    | "readWorkspaceFileMetadata"
    | "readWorkspaceFileText"
  >;
  files: readonly GitReviewFileSummary[];
  publishComplete: () => void;
  publishTracked: () => void;
  startStaleRecovery: () => void;
  status: () => string;
}

function createControlledReviewTransport(
  mode: ControlledReviewFixtureMode,
  onActivity: () => void,
): ControlledReviewTransport {
  const cwd = `/tmp/storybook/review-${mode}`;
  const source: GitReviewSource = "unstaged";
  const fixtureFiles = buildControlledFixtureFiles(mode);
  let publishedFiles = mode === "live-publication" ? fixtureFiles.slice(0, 1) : fixtureFiles;
  let generation = 1;
  let summarySubscriptionId = "";
  let listener: ((event: GitReviewLiveEvent) => void) | null = null;
  let activity = "Ready";
  let staleNextDiff = false;

  const setActivity = (next: string) => {
    activity = next;
    onActivity();
  };
  const publish = (phase: "tracked" | "complete") => {
    if (!listener || !summarySubscriptionId) {
      setActivity("Waiting for the live subscription");
      return;
    }
    listener({
      type: "git-live-query-updated",
      subscriptionId: summarySubscriptionId,
      generation,
      requiresRecovery: false,
      phase,
      method: "review-summary",
      result: {
        type: "success",
        source,
        files: [...publishedFiles],
        snapshotGeneration: generation,
        stageCounts: {
          stagedFileCount: 0,
          unstagedFileCount: publishedFiles.filter((file) => file.status !== "untracked").length,
          untrackedFileCount: publishedFiles.filter((file) => file.status === "untracked").length,
        },
        untrackedFilesOmitted: 0,
      },
    });
    setActivity(
      `${phase === "tracked" ? "Tracked" : "Complete"} generation ${generation}: ${publishedFiles.length} file${publishedFiles.length === 1 ? "" : "s"}`,
    );
  };

  const invoke = (async (channel: string, payload?: unknown) => {
    if (channel === "stable-metadata") {
      return {
        cwd,
        root: cwd,
        gitDir: `${cwd}/.git`,
        commonDir: `${cwd}/.git`,
        isGitRepository: true,
        currentBranch: "feature/review-fixture",
        defaultBranch: "main",
        errorMessage: null,
      };
    }
    if (channel === "review-summary") {
      return {
        type: "success",
        source,
        files: [...publishedFiles],
        snapshotGeneration: generation,
        stageCounts: {
          stagedFileCount: 0,
          unstagedFileCount: publishedFiles.filter((file) => file.status !== "untracked").length,
          untrackedFileCount: publishedFiles.filter((file) => file.status === "untracked").length,
        },
      };
    }
    if (channel === "subscribe-live-query") {
      const subscription = payload as GitReviewLiveSubscriptionInput | undefined;
      if (!subscription) return undefined;
      const { query, subscriptionId } = subscription;
      if (query.method === "review-summary") {
        summarySubscriptionId = subscriptionId;
        return undefined;
      }
      queueMicrotask(() => {
        if (!listener) return;
        if (query.method === "base-branch") {
          listener({
            type: "git-live-query-updated",
            subscriptionId,
            generation,
            requiresRecovery: false,
            phase: "complete",
            method: query.method,
            result: {
              cwd,
              local: "main",
              remote: null,
              errorMessage: null,
            },
          });
          return;
        }
        if (query.method === "branch-commits") {
          listener({
            type: "git-live-query-updated",
            subscriptionId,
            generation,
            requiresRecovery: false,
            phase: "complete",
            method: query.method,
            result: {
              cwd,
              baseBranch: query.params.baseBranch ?? "main",
              commits: [],
              errorMessage: null,
            },
          });
        }
      });
      return undefined;
    }
    if (channel === "unsubscribe-live-query" || channel === "worker-request-cancel") {
      return channel === "worker-request-cancel" ? { cancelled: true } : undefined;
    }
    if (channel === "refresh-live-query") {
      if (mode !== "stale-recovery") return undefined;
      generation += 1;
      publishedFiles = [
        buildControlledReviewSummary("src/stale-recovery.ts", {
          revision: `story:stale:${generation}`,
        }),
      ];
      staleNextDiff = false;
      setActivity(`Refresh accepted; publishing generation ${generation}`);
      queueMicrotask(() => publish("complete"));
      return undefined;
    }
    if (channel === "review-diff") {
      if (staleNextDiff) {
        staleNextDiff = false;
        setActivity(`Discarded stale generation ${generation} path response`);
        return { type: "stale-snapshot", source };
      }
      const request = payload as {
        files?: Array<{ path: string }>;
        snapshotGeneration?: number;
      };
      const requested = request.files ?? [];
      const files = requested.flatMap(({ path }) => {
        const file = publishedFiles.find((candidate) => candidate.path === path);
        return file ? [buildControlledReviewDiffEntry(file)] : [];
      });
      return {
        type: "success",
        cwd,
        source,
        patch: files.map((file) => file.diff).join("\n"),
        files,
        isGitRepository: true,
        baseRef: null,
        currentBranch: "feature/review-fixture",
        defaultBranch: "main",
        errorMessage: null,
        snapshotGeneration: request.snapshotGeneration ?? generation,
      };
    }
    if (channel === "review-cat-file") {
      const request = payload as {
        requests?: Array<{ oid: string | null; path: string }>;
        snapshotGeneration?: number;
      };
      const requests = request.requests ?? [];
      const fallbackPath = requests[0]?.path ?? "";
      if (mode === "full-content-fallbacks") {
        if (fallbackPath.endsWith("loading.ts")) {
          setActivity("Full-content loading request held open");
          return new Promise<never>(() => {});
        }
        if (fallbackPath.endsWith("failed.ts")) {
          setActivity("Full-content transport failed for failed.ts");
          throw new Error("Controlled full-content failure");
        }
      }
      const unavailable = fallbackPath.endsWith("unavailable.ts");
      return {
        snapshotGeneration: request.snapshotGeneration ?? generation,
        results: requests.map((item) =>
          unavailable
            ? { type: "error", error: { type: "not-found" } }
            : {
                type: "success",
                lines:
                  item.oid === STORY_OLD_OID
                    ? [`export const value = "before:${item.path}";\n`]
                    : [`export const value = "after:${item.path}";\n`],
              },
        ),
      };
    }
    return null;
  }) as (channel: string, payload?: unknown) => Promise<unknown>;

  const gitWorkerClient = {
    request: async (input: { method: string; params: unknown }) => {
      const channelByMethod: Record<string, string> = {
        "stable-metadata": "stable-metadata",
        "review-summary": "review-summary",
        "review-diff": "review-diff",
        "review-cat-file": "review-cat-file",
        "subscribe-live-query": "subscribe-live-query",
        "unsubscribe-live-query": "unsubscribe-live-query",
        "refresh-live-query": "refresh-live-query",
      };
      if (input.method === "base-branch") {
        return {
          cwd,
          local: "main",
          remote: null,
          errorMessage: null,
        };
      }
      if (input.method === "branch-commits") {
        return { cwd, baseBranch: "main", commits: [], errorMessage: null };
      }
      if (input.method === "recover-live-query") return { recovered: true };
      const channel = channelByMethod[input.method];
      if (!channel) throw new Error(`Unsupported story Git method: ${input.method}`);
      const value = await invoke(channel, input.params);
      if (input.method === "review-cat-file") {
        return { type: "success", value };
      }
      if (input.method === "subscribe-live-query") return { subscribed: true };
      if (input.method === "unsubscribe-live-query") return { unsubscribed: true };
      if (input.method === "refresh-live-query") return { refreshed: true };
      return value;
    },
    subscribe: (
      nextListener: (message: {
        type: "git-live-query-event";
        workerId: "git";
        event: GitReviewLiveEvent;
      }) => void,
    ) => {
      const nextEventListener = (event: GitReviewLiveEvent) =>
        nextListener({
          type: "git-live-query-event",
          workerId: "git",
          event,
        });
      listener = nextEventListener;
      return () => {
        if (listener === nextEventListener) listener = null;
      };
    },
  } as NonNullable<ReviewPanelDeps["gitWorkerClient"]>;

  return {
    deps: {
      initialSummaryQuery: mode !== "live-publication",
      readWorkspaceFileMetadata: (input) => invoke("read-file-metadata", input) as never,
      readWorkspaceFileText: (input) => invoke("read-file", input) as never,
      gitWorkerClient,
    },
    files: fixtureFiles,
    publishComplete() {
      publishedFiles = fixtureFiles;
      generation += 1;
      publish("complete");
    },
    publishTracked() {
      publishedFiles = fixtureFiles.slice(0, 1);
      generation += 1;
      publish("tracked");
    },
    startStaleRecovery() {
      if (mode !== "stale-recovery") return;
      generation += 1;
      publishedFiles = [
        buildControlledReviewSummary("src/stale-recovery.ts", {
          revision: `story:stale:${generation}`,
        }),
      ];
      staleNextDiff = true;
      publish("complete");
    },
    status: () => activity,
  };
}

interface ControlledStoryIntersectionObserver {
  emitPath: (path: string) => boolean;
  install: () => void;
  observedPathCount: () => number;
  restore: () => void;
}

function createControlledStoryIntersectionObserver(): ControlledStoryIntersectionObserver {
  const original = globalThis.IntersectionObserver;
  const observations = new Map<
    IntersectionObserver,
    { callback: IntersectionObserverCallback; targets: Set<Element> }
  >();
  let installed = false;

  class StoryIntersectionObserver implements IntersectionObserver {
    readonly root: Element | Document | null;
    readonly rootMargin: string;
    readonly scrollMargin = "0px";
    readonly thresholds: readonly number[];

    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
      this.root = options.root ?? null;
      this.rootMargin = options.rootMargin ?? "0px";
      this.thresholds = Array.isArray(options.threshold)
        ? options.threshold
        : [options.threshold ?? 0];
      observations.set(this, { callback, targets: new Set() });
    }

    disconnect(): void {
      observations.delete(this);
    }

    observe(target: Element): void {
      observations.get(this)?.targets.add(target);
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }

    unobserve(target: Element): void {
      observations.get(this)?.targets.delete(target);
    }
  }

  return {
    emitPath(path) {
      const row = document.querySelector<HTMLElement>(
        `section[data-review-path="${CSS.escape(path)}"]`,
      );
      if (!row) return false;
      let emitted = false;
      for (const [observer, record] of observations) {
        const targets = Array.from(record.targets).filter(
          (target) => target === row || row.contains(target),
        );
        if (targets.length === 0) continue;
        emitted = true;
        record.callback(
          targets.map(
            (target) =>
              ({
                target,
                isIntersecting: true,
                intersectionRatio: 1,
              }) as IntersectionObserverEntry,
          ),
          observer,
        );
      }
      return emitted;
    },
    install() {
      if (installed) return;
      installed = true;
      Object.defineProperty(globalThis, "IntersectionObserver", {
        configurable: true,
        writable: true,
        value: StoryIntersectionObserver,
      });
    },
    observedPathCount() {
      const paths = new Set<string>();
      for (const record of observations.values()) {
        for (const target of record.targets) {
          const row = target.matches("section[data-review-path]")
            ? target
            : target.closest("section[data-review-path]");
          const path = row?.getAttribute("data-review-path");
          if (path) paths.add(path);
        }
      }
      return paths.size;
    },
    restore() {
      if (!installed) return;
      installed = false;
      observations.clear();
      Object.defineProperty(globalThis, "IntersectionObserver", {
        configurable: true,
        writable: true,
        value: original,
      });
    },
  };
}

function ControlledReviewStorySurface({
  mode,
  ...args
}: ReviewStorySurfaceProps & { mode: ControlledReviewFixtureMode }) {
  const [, rerenderControls] = useReducer((value: number) => value + 1, 0);
  const transportRef = useRef<ControlledReviewTransport | null>(null);
  const viewportRef = useRef<ControlledStoryIntersectionObserver | null>(null);
  transportRef.current ??= createControlledReviewTransport(mode, rerenderControls);
  viewportRef.current ??= createControlledStoryIntersectionObserver();
  const transport = transportRef.current;
  const viewport = viewportRef.current;
  viewport.install();

  useEffect(() => {
    viewport.install();
    return () => viewport.restore();
  }, [viewport]);

  const deps = useMemo(() => ({ ...args.deps, ...transport.deps }), [args.deps, transport.deps]);
  const revealPath = (path: string) => {
    viewport.emitPath(path);
    rerenderControls();
  };

  return (
    <div className="relative h-screen overflow-hidden">
      <ReviewStorySurface {...args} deps={deps} />
      <div className="absolute top-12 right-3 z-50 flex max-w-sm flex-col gap-2 rounded-lg border border-token-border bg-token-main-surface-primary/95 p-3 text-xs text-token-foreground shadow-lg backdrop-blur">
        <div className="font-medium">Controlled review fixture</div>
        <div className="text-token-description-foreground">
          {transport.status()} · {viewport.observedPathCount()} viewport-gated rows
        </div>
        <div className="flex flex-wrap gap-1.5">
          {mode === "live-publication" ? (
            <>
              <button type="button" onClick={transport.publishTracked}>
                Publish tracked
              </button>
              <button type="button" onClick={transport.publishComplete}>
                Publish complete
              </button>
            </>
          ) : null}
          {mode === "viewport-gating" ? (
            <>
              <button type="button" onClick={() => revealPath(transport.files[0]?.path ?? "")}>
                Reveal first row
              </button>
              <button type="button" onClick={() => revealPath(transport.files.at(-1)?.path ?? "")}>
                Reveal last row
              </button>
            </>
          ) : null}
          {mode === "full-content-fallbacks"
            ? transport.files.map((file) => (
                <button key={file.path} type="button" onClick={() => revealPath(file.path)}>
                  Load {file.path.split("/").at(-1)?.replace(".ts", "")}
                </button>
              ))
            : null}
          {mode === "stale-recovery" ? (
            <button type="button" onClick={transport.startStaleRecovery}>
              Publish stale generation
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: "Workbench/Review Diff Panel",
  component: ReviewStorySurface,
  args: {
    conversation: buildStoryConversation(),
    onStartThreadPrompt: async () => undefined,
    projectWorkspacePath: "/Users/asc/repo/nodex",
  },
  render: (args) => <ReviewStorySurface {...args} />,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof ReviewStorySurface>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LastTurnWithoutFileTree: Story = {};

export const HeaderAndFileRows: Story = {
  args: {
    conversation: buildStoryConversation(),
    projectWorkspacePath: "/Users/asc/repo/nodex",
  },
};

export const AllDiffsCollapsed: Story = {
  args: {
    conversation: buildReviewParityConversation(),
    projectWorkspacePath: "/Users/asc/repo/nodex",
  },
  render: (args) => <ReviewStorySurface {...args} openControlLabel="Collapse all diffs" />,
  parameters: {
    docs: {
      description: {
        story:
          "Collapse-all keeps every virtualized diff connected while reducing the list to stable file headers; the matching expand-all action remains in the toolbar.",
      },
    },
  },
};

export const LastTurnWithFileTree: Story = {
  args: {
    initialFileTreeOpen: true,
  },
};

export const LineInfoAndIcons: Story = {
  args: {
    conversation: buildReviewParityConversation(),
    initialFileTreeOpen: true,
    projectWorkspacePath: "/Users/asc/repo/nodex",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Review diff parity fixture: line-info unchanged-range separators, compact file rows, and file-type icons should be visible together.",
      },
    },
  },
};

export const BinaryPlaceholder: Story = {
  args: {
    conversation: buildMetadataOnlyReviewConversation({
      threadId: "thr_story_review_binary",
      path: "assets/logo.png",
      safety: buildReviewFileSafety({
        binary: true,
        sizeBytes: 2_048,
        mimeType: "image/png",
      }),
    }),
    projectWorkspacePath: "/Users/asc/repo/nodex",
    initialFileTreeOpen: true,
  },
};

export const TooLargePlaceholder: Story = {
  args: {
    conversation: buildMetadataOnlyReviewConversation({
      threadId: "thr_story_review_large",
      path: "logs/debug.txt",
      safety: buildReviewFileSafety({
        tooLarge: true,
        sizeBytes: 1_048_577,
        mimeType: "text/plain",
      }),
    }),
    projectWorkspacePath: "/Users/asc/repo/nodex",
    initialFileTreeOpen: true,
  },
};

export const FileTreeChrome: Story = {
  args: {
    initialSource: "unstaged",
    initialFileTreeOpen: true,
    projectWorkspacePath: "/tmp/storybook/virtualized-tree",
  },
};

export const NoDiff: Story = {
  args: {
    initialSource: "unstaged",
    projectWorkspacePath: "/tmp/storybook/no-diff",
  },
};

export const BranchReview: Story = {
  args: {
    initialSource: "branch",
    initialFileTreeOpen: true,
    projectWorkspacePath: "/Users/asc/repo/nodex",
  },
};

export const NoGitRepository: Story = {
  args: {
    initialSource: "unstaged",
    projectWorkspacePath: "/tmp/storybook/no-git",
  },
};

export const LargeDiffCappedMode: Story = {
  args: {
    initialSource: "unstaged",
    initialFileTreeOpen: true,
    projectWorkspacePath: "/tmp/storybook/large-diff",
  },
};

export const LargeDiffCappedModeCollapsed: Story = {
  args: {
    initialSource: "unstaged",
    projectWorkspacePath: "/tmp/storybook/large-diff",
  },
};

export const VirtualizedFileTree: Story = {
  args: {
    initialSource: "unstaged",
    initialFileTreeOpen: true,
    projectWorkspacePath: "/tmp/storybook/virtualized-tree",
  },
};

export const NestedFileTree: Story = {
  args: {
    initialSource: "unstaged",
    initialFileTreeOpen: true,
    projectWorkspacePath: "/tmp/storybook/virtualized-tree",
  },
};

export const TreeStatusAndSelection: Story = {
  args: {
    initialSource: "unstaged",
    initialFileTreeOpen: true,
    projectWorkspacePath: "/tmp/storybook/virtualized-tree",
  },
};

export const StagedEmpty: Story = {
  args: {
    initialSource: "staged",
    projectWorkspacePath: "/tmp/storybook/staged-empty",
  },
};

export const UnstagedChanges: Story = {
  args: {
    initialSource: "unstaged",
    projectWorkspacePath: "/Users/asc/repo/nodex",
  },
};

export const OptionsMenuOpen: Story = {
  args: {
    initialSource: "unstaged",
    projectWorkspacePath: "/Users/asc/repo/nodex",
  },
  render: (args) => <ReviewStorySurface {...args} openControlLabel="Review options" />,
  parameters: {
    docs: {
      description: {
        story:
          "The default full-file loading state is on, so the open menu should offer `Don't load full files`.",
      },
    },
  },
};

export const JumpToFileOpen: Story = {
  args: {
    initialSource: "unstaged",
    initialFileTreeOpen: true,
    projectWorkspacePath: "/tmp/storybook/virtualized-tree",
  },
  render: (args) => <ReviewStorySurface {...args} openControlLabel="Jump to file" />,
};

export const InlineComment: Story = {
  args: {
    conversation: buildCommentStoryConversation(),
    projectWorkspacePath: "/Users/asc/repo/nodex",
  },
};

export const PendingLocalComment: Story = {
  args: {
    conversation: buildStoryConversation(),
    projectWorkspacePath: "/Users/asc/repo/nodex",
  },
  render: (args) => (
    <ReviewStorySurface
      {...args}
      pendingCommentAttachments={[
        buildStoryPendingComment({
          id: "story_local_comment",
          path: "src/renderer/components/workbench/workbench-shell.tsx",
          side: "right",
          line: 1771,
          text: "Request this change before the next turn.",
        }),
      ]}
    />
  ),
};

export const RangeLocalComment: Story = {
  args: {
    conversation: buildStoryConversation(),
    projectWorkspacePath: "/Users/asc/repo/nodex",
  },
  render: (args) => (
    <ReviewStorySurface
      {...args}
      pendingCommentAttachments={[
        buildStoryPendingComment({
          id: "story_range_comment",
          path: "src/renderer/components/workbench/workbench-shell.tsx",
          side: "right",
          line: 1771,
          startLine: 1769,
          startSide: "left",
          text: "Keep this range aligned with the removed placeholder path.",
        }),
      ]}
    />
  ),
};

export const LiveTrackedThenComplete: Story = {
  args: {
    initialSource: "unstaged",
    initialFileTreeOpen: true,
    projectWorkspacePath: "/Users/asc/repo/nodex",
  },
  render: (args) => <ControlledReviewStorySurface {...args} mode="live-publication" />,
  parameters: {
    docs: {
      description: {
        story:
          "The live summary may publish tracked files first and then atomically add untracked files without resetting already loaded rows.",
      },
    },
  },
};

export const AgentStreamingIsolation: Story = {
  args: {
    conversation: buildReviewParityConversation(),
    projectWorkspacePath: "/Users/asc/repo/nodex",
  },
  parameters: {
    docs: {
      description: {
        story:
          "A static conversation fixture for manually comparing Review projection and file-row identity. It does not simulate a live assistant stream.",
      },
    },
  },
};

export const ViewportGatedFullContent: Story = {
  args: {
    initialSource: "unstaged",
    initialFileTreeOpen: true,
    projectWorkspacePath: "/tmp/storybook/virtualized-tree",
  },
  render: (args) => <ControlledReviewStorySurface {...args} mode="viewport-gating" />,
  parameters: {
    docs: {
      description: {
        story:
          "A many-file partial review for checking that only expanded rows inside the virtualizer margin request full content.",
      },
    },
  },
};

export const FullContentFallbackStates: Story = {
  args: {
    conversation: buildReviewParityConversation(),
    initialSource: "unstaged",
    projectWorkspacePath: "/tmp/storybook/full-content-fallback",
  },
  render: (args) => <ControlledReviewStorySurface {...args} mode="full-content-fallbacks" />,
  parameters: {
    docs: {
      description: {
        story:
          "Inspect `data-review-full-content-state` while exercising loading, success, unavailable, and failed reads; every terminal fallback keeps the partial diff visible.",
      },
    },
  },
};

export const StaleSnapshotRecovery: Story = {
  args: {
    initialSource: "unstaged",
    projectWorkspacePath: "/tmp/storybook/stale-snapshot",
  },
  render: (args) => <ControlledReviewStorySurface {...args} mode="stale-recovery" />,
  parameters: {
    docs: {
      description: {
        story:
          "This controlled fixture injects one stale per-path diff response, then accepts repository refresh and publishes a new generation. It does not inject stale full-content or search responses.",
      },
    },
  },
};

export const GeneratedAttributesServerSearch: Story = {
  args: {
    initialSource: "unstaged",
    initialFileTreeOpen: true,
    projectWorkspacePath: "/tmp/storybook/generated-attributes",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Generated classification is intentionally unresolved in this fixture, forcing content search through the generation-bound server path.",
      },
    },
  },
};
