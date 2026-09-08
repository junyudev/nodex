import {
  createThreadHandoffStore,
  ThreadHandoffStoreProvider,
} from "../../../../../lib/thread-handoff-runtime";
import type {
  CodexAppHandoffOperation,
  CodexThreadHandoffSnapshot,
} from "../../../../../../shared/codex-thread-handoff";
import { buildThreadHandoffOperation } from "../../../../../test/thread-handoff-fixture";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  CodexFileChange,
  CodexMcpToolCallContentBlock,
  CodexMcpToolCallNormalizedResult,
  CodexProtocolRequestId,
  CodexTranscriptEntry,
  ProtocolAppInfo,
} from "@/lib/types";
import {
  buildCodexFileChangeMap,
  resolveCodexPatchSuccess,
} from "../../../../../../shared/codex-file-change";
import { normalizeCodexAppInfoLogos } from "../../../../../../shared/codex-app-info";
import {
  agentActivityV2FallbackCommandItem,
  agentActivityV2MultiActionCommandItem,
} from "../../../../../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-item-family-corpus";
import type {
  CodexAutomaticApprovalReviewRiskLevel,
  CodexAutomaticApprovalReviewStatus,
} from "../../../../../../shared/codex-transcript-special-items";
import { ThreadBlockRenderer } from "../../blocks/local-conversation-block-renderer";
import { ThreadLiveActivityFallback } from "../../local-conversation-thread-turn";
import {
  buildThreadToolActivityProjectionFixture,
  buildThreadToolActivityProjectionScenario,
  type ThreadToolActivityProjectionFixtureResult,
  type ThreadToolActivityProjectionScenarioId,
} from "../../../projection/test-fixtures/thread-tool-activity-projection-fixtures";
import { LOCAL_CONVERSATION_CONTENT_CLASS_NAME } from "../local-conversation-view-constants";
import { TurnDiffPatchFailureDialog, TurnDiffSurface } from "../turn-diff-surface";
import { getToolComponent } from "./get-tool-component";
import { DynamicToolCall } from "./dynamic-tool-call";
import { McpToolCall } from "./mcp-tool-call";
import { ThreadMcpAppsProvider } from "./mcp-apps-context";
import { ToolActivityIcon, semanticToolIcon } from "./tool-call-icons";
import { THREAD_TOOL_CALL_STORY_ITEMS } from "../../thread-stage-story-fixtures";

const LONG_COMMAND = [
  "bun x tsx scripts/collect-long-command-metrics.ts",
  "--project nodex",
  "--scope renderer",
  "--filter command-tool-call",
  "--json",
  "--include src/renderer/features/local-conversation/view/shared/tools/command-tool-call.tsx",
  "--include src/renderer/features/local-conversation/view/shared/tools/thread-command-shell-block.tsx",
  "--include src/renderer/features/local-conversation/view/shared/tools/thread-tool-calls.stories.tsx",
  "--include src/renderer/features/local-conversation/view/shared/tools/command-tool-call.render.test.tsx",
  "--group-by semanticKind,status,toolName",
  "--output /tmp/nodex-command-shell-regression-fixture.json",
].join(" ");

const COMMAND_ITEM = THREAD_TOOL_CALL_STORY_ITEMS.command;
function buildCommandItem(overrides?: Partial<typeof COMMAND_ITEM>) {
  return {
    ...COMMAND_ITEM,
    ...overrides,
  };
}

function buildMcpSourceStoryItem(
  id: string,
  source: NonNullable<NonNullable<CodexTranscriptEntry["mcpToolCall"]>["source"]>,
): CodexTranscriptEntry {
  const base = THREAD_TOOL_CALL_STORY_ITEMS.mcp;
  if (!base.mcpToolCall) return base;

  return {
    ...base,
    itemId: id,
    entryId: id,
    mcpToolCall: {
      ...base.mcpToolCall,
      callId: id,
      functionName: `node_repl__${source.kind}`,
      source,
      invocation: {
        server: "node_repl",
        tool: source.kind === "browserUse" ? "browser_action" : "computer_action",
        arguments: {},
      },
    },
  };
}

function buildMcpAppInfoStoryItem(id: string): CodexTranscriptEntry {
  const base = THREAD_TOOL_CALL_STORY_ITEMS.mcp;
  if (!base.mcpToolCall) return base;
  return {
    ...base,
    itemId: id,
    entryId: id,
    mcpToolCall: {
      ...base.mcpToolCall,
      callId: id,
      functionName: "docs__search",
      source: null,
      invocation: { server: "docs", tool: "search", arguments: {} },
    },
  };
}

function buildMcpResultStoryItem(
  id: string,
  result: CodexMcpToolCallNormalizedResult,
): CodexTranscriptEntry {
  const base = THREAD_TOOL_CALL_STORY_ITEMS.mcp;
  if (!base.mcpToolCall) return base;

  return {
    ...base,
    itemId: id,
    entryId: id,
    status: result?.type === "error" ? "failed" : "completed",
    toolCall: base.toolCall
      ? {
          ...base.toolCall,
          result:
            result?.type === "success"
              ? {
                  type: "success",
                  content: result.content,
                  structuredContent: result.structuredContent,
                }
              : undefined,
          error: result?.type === "error" ? result.error : undefined,
        }
      : base.toolCall,
    mcpToolCall: {
      ...base.mcpToolCall,
      callId: id,
      durationMs: 640,
      completed: true,
      result,
    },
  };
}

function buildLargeMcpTextResult(prefix: string): CodexMcpToolCallNormalizedResult {
  const content = [
    {
      type: "text" as const,
      text: Array.from(
        { length: 2_000 },
        (_value, index) =>
          `${prefix} ${index + 1}: exact connector output remains available without mounting the complete payload inline.`,
      ).join("\n"),
    },
  ];

  return {
    type: "success",
    content,
    structuredContent: null,
    raw: {
      content,
      structuredContent: null,
      _meta: null,
    },
  };
}

const MCP_RARE_CONTENT_BLOCKS: CodexMcpToolCallContentBlock[] = [
  {
    type: "text",
    text: "The tool returned text with audience and priority annotations.",
    annotations: { audience: ["assistant", "user"], priority: 0.8 },
  },
  {
    type: "resource_link",
    uri: "file:///workspace/nodex/docs/RELIABILITY.md",
    title: "Reliability contract",
    annotations: { audience: ["assistant"], lastModified: "2026-07-14T02:00:00Z" },
  },
  {
    type: "embedded_resource",
    resource: {
      uri: "memory://mcp/result-note",
      mimeType: "text/markdown",
      text: "# Embedded result\n\nThis body is rendered inline with its URI and MIME metadata.",
      annotations: { priority: 0.5 },
    },
  },
  {
    type: "image",
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    annotations: { audience: ["user"] },
  },
  {
    type: "audio",
    mimeType: "audio/wav",
    data: "UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=",
    annotations: { audience: ["user"] },
  },
];

const MCP_APP_INFO_STORY_APPS = normalizeCodexAppInfoLogos([
  {
    id: "connector_docs",
    name: "Docs",
    description: null,
    logoUrl: null,
    logoUrlDark: null,
    iconAssets: {
      "256_square":
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' rx='7' fill='%230b57d0'/%3E%3Cpath d='M9 8h10l4 4v12H9z' fill='white'/%3E%3C/svg%3E",
    },
    iconDarkAssets: {
      "256_square":
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' rx='7' fill='%238ab4f8'/%3E%3Cpath d='M9 8h10l4 4v12H9z' fill='%23101828'/%3E%3C/svg%3E",
    },
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: null,
    isAccessible: true,
    isEnabled: true,
    pluginDisplayNames: [],
  } satisfies ProtocolAppInfo,
]);

function buildStoryFileChangePayload(changes: CodexFileChange[], success: boolean | null = true) {
  return {
    label:
      changes.length === 1
        ? `${changes[0]?.type === "add" ? "Created" : changes[0]?.type === "delete" ? "Deleted" : "Edited"} ${changes[0]?.path}`
        : undefined,
    changes: buildCodexFileChangeMap(changes),
    success,
  };
}

function buildStoryFileChangeToolCall(changes: CodexFileChange[]) {
  const payload = buildStoryFileChangePayload(changes);

  return {
    subtype: "fileChange" as const,
    toolName: "file_change",
    args: {
      label: payload.label,
    },
    result: { changes: payload.changes },
  };
}

function buildStoryFileChangeItem({
  approvalRequestId,
  changes,
  id,
  status = "completed",
}: {
  approvalRequestId?: CodexProtocolRequestId | null;
  changes: CodexFileChange[];
  id: string;
  status?: CodexTranscriptEntry["status"];
}): CodexTranscriptEntry {
  return {
    ...THREAD_TOOL_CALL_STORY_ITEMS.fileChange,
    itemId: id,
    entryId: id,
    status,
    approvalRequestId,
    fileChange: buildStoryFileChangePayload(changes, resolveCodexPatchSuccess(status)),
    toolCall: buildStoryFileChangeToolCall(changes),
  };
}

type StoryAutoReview = {
  status: CodexAutomaticApprovalReviewStatus;
  riskLevel?: CodexAutomaticApprovalReviewRiskLevel | null;
  rationale?: string | null;
};

function buildAutoReviewStoryItem(id: string, review: StoryAutoReview): CodexTranscriptEntry {
  return {
    threadId: "thread_tool_story",
    turnId: "turn_tool_story",
    itemId: `automatic-approval-review:${id}`,
    entryId: `automatic-approval-review:${id}`,
    type: "automaticApprovalReview",
    kind: "systemEvent",
    semanticKind: "automaticApprovalReview",
    status: review.status === "inProgress" ? "inProgress" : "completed",
    markdownText: review.rationale ?? "",
    rawItem: {
      targetItemId: "tool-call-file-change-auto-review-states",
      review: {
        status: review.status,
        riskLevel: review.riskLevel ?? null,
        userAuthorization: "unknown",
        rationale: review.rationale ?? null,
      },
      action: null,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function StorySurface({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-[320px] rounded-[24px] border border-(--border) bg-(--background) p-5 shadow-[0_18px_48px_rgba(0,0,0,0.16)]">
      <div className="mb-4 max-w-2xl">
        <div className="text-sm font-semibold text-(--foreground)">{title}</div>
        <div className="mt-1 text-sm/relaxed text-(--foreground-secondary)">{description}</div>
      </div>
      <div className="max-w-3xl">{children}</div>
    </div>
  );
}

function ConversationStorySurface({ children }: { children: ReactNode }) {
  return (
    <div data-thread-find-target="conversation" className={LOCAL_CONVERSATION_CONTENT_CLASS_NAME}>
      {children}
    </div>
  );
}

function ProjectedToolActivity({
  fixture,
  autoOpen = false,
}: {
  fixture: ThreadToolActivityProjectionFixtureResult;
  autoOpen?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!autoOpen) return;
    const root = containerRef.current;
    if (!root) return;
    const frameId = requestAnimationFrame(() => {
      root.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click();
    });
    return () => cancelAnimationFrame(frameId);
  }, [autoOpen]);

  const { model } = fixture;
  return (
    <ThreadMcpAppsProvider apps={[]}>
      <div ref={containerRef} className="flex flex-col gap-[var(--conversation-item-gap,16px)]">
        {model.agentBodyUnits.map((unit) => (
          <div key={unit.block.renderKey ?? unit.block.id} {...unit.targetAttributes}>
            <ThreadBlockRenderer
              block={unit.block}
              isLatestTurn={model.isLatestTurn}
              isStreamingTurn={model.isStreamingTurn}
              projectWorkspacePath="/workspace/project"
              threadCwd="/workspace/project"
            />
          </div>
        ))}
        {model.liveActivity.fallback.owner === "standalone" ? (
          <ThreadLiveActivityFallback message={model.liveActivity.fallback.message} />
        ) : null}
      </div>
    </ThreadMcpAppsProvider>
  );
}

function ProjectedToolActivityScenario({
  id,
  autoOpen = false,
}: {
  id: ThreadToolActivityProjectionScenarioId;
  autoOpen?: boolean;
}) {
  return (
    <ProjectedToolActivity
      fixture={buildThreadToolActivityProjectionScenario(id)}
      autoOpen={autoOpen}
    />
  );
}

const EMPTY_AUTOMATIC_APPROVAL_REVIEWS: CodexTranscriptEntry[] = [];

function ToolCallStory({
  item,
  title,
  description,
  autoOpen = false,
  autoExpandCommandLine = false,
  isTurnCancelled = false,
  isStreamingTurn = true,
  automaticApprovalReviews = EMPTY_AUTOMATIC_APPROVAL_REVIEWS,
}: {
  item: CodexTranscriptEntry;
  title: string;
  description: string;
  autoOpen?: boolean;
  autoExpandCommandLine?: boolean;
  isTurnCancelled?: boolean;
  isStreamingTurn?: boolean;
  automaticApprovalReviews?: CodexTranscriptEntry[];
}) {
  const ToolComponent = getToolComponent(item);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!autoOpen && !autoExpandCommandLine) return;

    const root = containerRef.current;
    if (!root) return;

    let frameId = 0;
    let nestedFrameId = 0;

    const clickSummaryToggle = () => {
      const summaryToggle = root.querySelector<HTMLElement>(
        '[data-file-change-row-header], button[aria-expanded="false"], [data-command-tool-summary-toggle]',
      );
      summaryToggle?.click();
    };

    frameId = window.requestAnimationFrame(() => {
      if (autoOpen) {
        clickSummaryToggle();
      }

      nestedFrameId = window.requestAnimationFrame(() => {
        if (!autoExpandCommandLine) return;
        if (!root.querySelector("[data-command-shell-line-toggle]")) {
          clickSummaryToggle();
        }
        root.querySelector<HTMLElement>("[data-command-shell-line-toggle]")?.click();
      });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      window.cancelAnimationFrame(nestedFrameId);
    };
  }, [autoExpandCommandLine, autoOpen]);

  if (!ToolComponent) return null;

  return (
    <StorySurface title={title} description={description}>
      <ConversationStorySurface>
        <div ref={containerRef}>
          <ToolComponent
            item={item}
            projectWorkspacePath="/workspace/nodex"
            threadCwd="/workspace/nodex"
            isTurnCancelled={isTurnCancelled}
            isStreamingTurn={isStreamingTurn}
            automaticApprovalReviews={automaticApprovalReviews}
          />
        </div>
      </ConversationStorySurface>
    </StorySurface>
  );
}

function buildLivePatchProjectionFixture(
  lineCount: number,
): ThreadToolActivityProjectionFixtureResult {
  const addedLines = Array.from(
    { length: lineCount },
    (_value, index) => `+Generated line ${index + 1}`,
  );
  return buildThreadToolActivityProjectionFixture({
    id: `live-patch-${lineCount}`,
    rawItems: [
      {
        type: "fileChange",
        id: "tool-call-file-change-live-patch",
        status: "inProgress",
        changes: [
          {
            path: "poem.md",
            kind: { type: "add" },
            diff: [`@@ -0,0 +1,${lineCount} @@`, ...addedLines].join("\n"),
          },
        ],
      },
    ],
    turnStatus: "inProgress",
    lifecycleStatusByItemId: {
      "tool-call-file-change-live-patch": "inProgress",
    },
  });
}

function FileChangeLivePatchUpdateStory() {
  const counts = [0, 1, 9, 10, 35, 85];
  const [countIndex, setCountIndex] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setCountIndex((current) => (current + 1) % counts.length);
    }, 900);
    return () => window.clearInterval(interval);
  }, [counts.length]);

  return (
    <StorySurface
      title="File Change Live Patch Update"
      description="Live draft file edits appear as a single collapsed activity group immediately, then the header digit stack grows from +0 through +85."
    >
      <ConversationStorySurface>
        <ProjectedToolActivity
          fixture={buildLivePatchProjectionFixture(counts[countIndex] ?? 85)}
        />
      </ConversationStorySurface>
    </StorySurface>
  );
}

function AutoOpenMcpToolCall({
  automaticApprovalReviews = EMPTY_AUTOMATIC_APPROVAL_REVIEWS,
  item,
  rawDialogOpen = false,
}: {
  automaticApprovalReviews?: CodexTranscriptEntry[];
  item: CodexTranscriptEntry;
  rawDialogOpen?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const toggle = containerRef.current?.querySelector<HTMLElement>(
      'button[aria-expanded="false"]',
    );
    if (!toggle) return;
    toggle.click();
  }, []);

  return (
    <ConversationStorySurface>
      <div ref={containerRef}>
        <McpToolCall
          automaticApprovalReviews={automaticApprovalReviews}
          item={item}
          rawDialogOpen={rawDialogOpen}
        />
      </div>
    </ConversationStorySurface>
  );
}

function PartiallyVisibleScrollAnchorHarness({ item }: { item: CodexTranscriptEntry }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ToolComponent = getToolComponent(item);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = 84;
  }, []);

  if (!ToolComponent) {
    throw new Error("Expected command tool-call story item to resolve a tool component.");
  }

  return (
    <ConversationStorySurface>
      <div
        ref={scrollRef}
        className="max-h-96 overflow-y-auto rounded-2xl border border-token-border bg-token-main-surface-primary/40 p-4"
      >
        <div className="space-y-3">
          <div className="rounded-xl bg-token-foreground/4 px-4 py-3 text-token-description-foreground">
            Scroll position is pre-set so the command card header remains visible while earlier
            transcript rows sit above the viewport.
          </div>
          <div className="rounded-xl bg-token-foreground/4 px-4 py-3 text-token-description-foreground">
            Expanding and collapsing the tool body should not shift the visible header or drag the
            surrounding thread position.
          </div>
          <ToolComponent
            item={item}
            projectWorkspacePath="/workspace/nodex"
            threadCwd="/workspace/nodex"
          />
          <div className="rounded-xl bg-token-foreground/4 px-4 py-3 text-token-description-foreground">
            Additional transcript rows below the command card keep the scroll container tall enough
            to reproduce the anchoring edge case.
          </div>
          <div className="rounded-xl bg-token-foreground/4 px-4 py-3 text-token-description-foreground">
            The transcript should stay visually stable while nested tool accordions remeasure.
          </div>
        </div>
      </div>
    </ConversationStorySurface>
  );
}

function buildTurnDiffItem(
  itemId: string,
  unifiedDiff: string,
  showRevertButton = false,
): CodexTranscriptEntry {
  return {
    ...THREAD_TOOL_CALL_STORY_ITEMS.turnDiff,
    itemId,
    entryId: itemId,
    rawItem: {
      type: "turn-diff",
      cwd: "/workspace/nodex",
      unifiedDiff,
      showRevertButton,
    },
  };
}

function buildStoryDiffFile(path: string, additions: number, deletions: number): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${Math.max(1, deletions)} +1,${Math.max(1, additions)} @@`,
    ...Array.from({ length: deletions }, (_, index) => `-export const removed${index} = ${index};`),
    ...Array.from({ length: additions }, (_, index) => `+export const added${index} = ${index};`),
  ].join("\n");
}

function buildDistributedTurnDiff(fileCount: number, additions: number, deletions: number): string {
  return Array.from({ length: fileCount }, (_, index) => {
    const addBase = Math.floor(additions / fileCount);
    const delBase = Math.floor(deletions / fileCount);
    const fileAdditions = addBase + (index < additions % fileCount ? 1 : 0);
    const fileDeletions = delBase + (index < deletions % fileCount ? 1 : 0);
    const suffix = String(index + 1).padStart(2, "0");
    return buildStoryDiffFile(`src/renderer/feature-${suffix}.tsx`, fileAdditions, fileDeletions);
  }).join("\n");
}

const meta = {
  title: "Workbench/Threads/Tool Calls",
  component: ToolCallStory,
  parameters: {
    docs: {
      description: {
        component:
          "Focused leaf-story coverage for the Codex tool and tool-group surfaces used by mounted turns.",
      },
    },
  },
  args: {
    item: THREAD_TOOL_CALL_STORY_ITEMS.command,
    title: "Tool call",
    description: "Thread tool call surface.",
  },
} satisfies Meta<typeof ToolCallStory>;

export default meta;

type Story = StoryObj<typeof meta>;

function DynamicToolQueryStoryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
        },
      }),
  );
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

export const CommandExecution: Story = {
  render: () => (
    <ToolCallStory
      item={THREAD_TOOL_CALL_STORY_ITEMS.command}
      title="Command Execution"
      description="Structured command summary, output body, and metadata for a settled command run."
    />
  ),
};

export const AutoReviewDeclinedTools: Story = {
  render: () => {
    const reviews = [
      buildAutoReviewStoryItem("declined", {
        status: "denied",
        riskLevel: "high",
        rationale: "The proposed action requires authorization.",
      }),
    ];
    return (
      <div className="flex flex-col gap-4">
        <ToolCallStory
          title="Command Declined by Auto-review"
          description="A declined read is presented as a command awaiting explicit authorization. Expand it to inspect the original command and output."
          item={buildCommandItem({
            status: "declined",
            executionStatus: "declined",
            command: "cat private.txt",
            parsedCmd: {
              type: "read",
              cmd: "cat private.txt",
              name: "private.txt",
              path: "private.txt",
              isFinished: true,
            },
            aggregatedOutput: "Automatic approval review denied this request.",
            exitCode: null,
            durationMs: 5_000,
          })}
          automaticApprovalReviews={reviews}
        />
        <ToolCallStory
          title="File Change Declined by Auto-review"
          description="A declined file change retains the proposed diff and explains the required authorization."
          item={{
            ...THREAD_TOOL_CALL_STORY_ITEMS.fileChange,
            status: "declined",
            fileChange: {
              changes: {
                "src/proposed.ts": { type: "add", content: "export const proposed = true;\n" },
              },
              success: false,
            },
          }}
          automaticApprovalReviews={reviews}
        />
      </div>
    );
  },
};

export const CommandExecutionSummarySpecials: Story = {
  render: () => {
    const items = [
      buildCommandItem({
        itemId: "tool-call-date-summary",
        entryId: "tool-call-date-summary",
        status: "completed",
        markdownText: "Checked the current date and time",
        command: "date -u",
        aggregatedOutput: "Sun Jul  5 10:24:00 UTC 2026\n",
        exitCode: 0,
      }),
      buildCommandItem({
        itemId: "tool-call-background-summary",
        entryId: "tool-call-background-summary",
        status: "inProgress",
        markdownText: "Started background terminal",
        command: "bun run dev",
        aggregatedOutput: "ready in 421ms\n",
        exitCode: null,
        processId: "4172",
      }),
      buildCommandItem({
        itemId: "tool-call-skill-script-summary",
        entryId: "tool-call-skill-script-summary",
        status: "inProgress",
        markdownText: "Started background terminal",
        command: "python .codex/skills/review-helper/scripts/check.py",
        aggregatedOutput: "review started\n",
        exitCode: null,
        processId: "4188",
      }),
    ];

    return (
      <StorySurface
        title="Command Execution Summary Specials"
        description="Date checks and background terminal commands use compact semantic summaries while the shell body stays manually expandable."
      >
        <ConversationStorySurface>
          <div className="flex flex-col gap-3">
            {items.map((item) => {
              const ToolComponent = getToolComponent(item);
              if (!ToolComponent) return null;
              return (
                <ToolComponent
                  key={item.itemId}
                  item={item}
                  projectWorkspacePath="/workspace/nodex"
                  threadCwd="/workspace/nodex"
                  isStreamingTurn={item.processId == null}
                />
              );
            })}
          </div>
        </ConversationStorySurface>
      </StorySurface>
    );
  },
};

export const CommandExecutionLongCommandCollapsed: Story = {
  render: () => (
    <ToolCallStory
      item={{
        ...buildCommandItem(),
        itemId: "tool-call-long-command-collapsed",
        entryId: "tool-call-long-command-collapsed",
        command: LONG_COMMAND,
      }}
      title="Command Execution Long Command Collapsed"
      description="Transcript shell commands start line-clamped inside the expanded embedded shell block."
      autoOpen
    />
  ),
};

export const CommandExecutionLongCommandExpanded: Story = {
  render: () => (
    <ToolCallStory
      item={{
        ...buildCommandItem(),
        itemId: "tool-call-long-command-expanded",
        entryId: "tool-call-long-command-expanded",
        command: LONG_COMMAND,
      }}
      title="Command Execution Long Command Expanded"
      description="Clicking the embedded shell command line expands it instead of always truncating with ellipsis."
      autoOpen
      autoExpandCommandLine
    />
  ),
};

export const CommandExecutionScrollAnchorHarness: Story = {
  render: () => {
    const item = {
      ...buildCommandItem(),
      itemId: "tool-call-scroll-anchor-harness",
      entryId: "tool-call-scroll-anchor-harness",
      command: LONG_COMMAND,
    };
    const ToolComponent = getToolComponent(item);
    if (!ToolComponent) {
      throw new Error("Expected command tool-call story item to resolve a tool component.");
    }

    return (
      <StorySurface
        title="Command Execution Scroll Anchor Harness"
        description="Places a long embedded shell card inside a constrained scroll container so header stability can be inspected while expanding and collapsing the tool body."
      >
        <ConversationStorySurface>
          <div className="max-h-96 overflow-y-auto rounded-2xl border border-token-border bg-token-main-surface-primary/40 p-4">
            <div className="space-y-3">
              <div className="rounded-xl bg-token-foreground/4 px-4 py-3 text-token-description-foreground">
                Earlier transcript content above the embedded shell card.
              </div>
              <div className="rounded-xl bg-token-foreground/4 px-4 py-3 text-token-description-foreground">
                Use this harness to verify that expanding the tool body does not drag the visible
                header position.
              </div>
              <ToolComponent
                item={item}
                projectWorkspacePath="/workspace/nodex"
                threadCwd="/workspace/nodex"
              />
              <div className="rounded-xl bg-token-foreground/4 px-4 py-3 text-token-description-foreground">
                Later transcript content below the tool card.
              </div>
              <div className="rounded-xl bg-token-foreground/4 px-4 py-3 text-token-description-foreground">
                The visible card header should remain visually anchored while the body expands.
              </div>
            </div>
          </div>
        </ConversationStorySurface>
      </StorySurface>
    );
  },
};

export const CommandExecutionInProgressNoOutput: Story = {
  render: () => (
    <ToolCallStory
      item={{
        ...buildCommandItem(),
        itemId: "tool-call-running-no-output",
        entryId: "tool-call-running-no-output",
        status: "inProgress",
        markdownText: "Running bun test",
        command: "bun test",
        aggregatedOutput: "",
        exitCode: null,
      }}
      title="Command Execution In Progress Without Output"
      description="Running shell commands keep the embedded output area blank until real output arrives."
      autoOpen
    />
  ),
};

export const CommandExecutionFailedExitCode: Story = {
  render: () => (
    <ToolCallStory
      item={{
        ...buildCommandItem(),
        itemId: "tool-call-failed-exit-code",
        entryId: "tool-call-failed-exit-code",
        status: "failed",
        command: "bun test",
        aggregatedOutput: "tests failed\n",
        exitCode: 7,
      }}
      title="Command Execution Failed Exit Code"
      description="The embedded shell footer reads the canonical exit code instead of inferring terminal state from output text."
      autoOpen
    />
  ),
};

export const CommandExecutionStopped: Story = {
  render: () => (
    <ToolCallStory
      item={{
        ...buildCommandItem(),
        itemId: "tool-call-stopped",
        entryId: "tool-call-stopped",
        status: "interrupted",
        command: "bun test",
        aggregatedOutput: "stopped by user\n",
        exitCode: null,
      }}
      title="Command Execution Stopped"
      description="Interrupted commands render the stopped footer state."
      autoOpen
    />
  ),
};

export const CommandExecutionUnknownExitCode: Story = {
  render: () => (
    <ToolCallStory
      item={{
        ...buildCommandItem(),
        itemId: "tool-call-unknown-exit-code",
        entryId: "tool-call-unknown-exit-code",
        status: "failed",
        command: "bun test",
        aggregatedOutput: "process ended before an exit code was reported\n",
        exitCode: null,
      }}
      title="Command Execution Unknown Exit Code"
      description="Commands without a canonical exit code render the unknown-exit footer."
      autoOpen
    />
  ),
};

export const CommandExecutionTruncatedOutput: Story = {
  render: () => (
    <ToolCallStory
      item={{
        ...buildCommandItem(),
        itemId: "tool-call-truncated-output",
        entryId: "tool-call-truncated-output",
        status: "completed",
        command: "bun test",
        aggregatedOutput: [
          "[output truncated]",
          ...Array.from(
            { length: 32 },
            (_, index) => `line ${String(index + 1).padStart(2, "0")}  pass`,
          ),
        ].join("\n"),
        exitCode: 0,
      }}
      title="Command Execution Truncated Output"
      description="Long shell output keeps the truncation prefix and uses the reversed scroll container."
      autoOpen
    />
  ),
};

export const CommandExecutionScrollAnchorPartiallyVisible: Story = {
  render: () => {
    const item = {
      ...buildCommandItem(),
      itemId: "tool-call-scroll-anchor-partially-visible",
      entryId: "tool-call-scroll-anchor-partially-visible",
      command: LONG_COMMAND,
    };

    return (
      <StorySurface
        title="Command Execution Scroll Anchor Partially Visible"
        description="Matches the Codex regression case where a tool-call header is still visible while the expanded body remeasures inside the virtualized transcript."
      >
        <PartiallyVisibleScrollAnchorHarness item={item} />
      </StorySurface>
    );
  },
};

export const FileChange: Story = {
  render: () => (
    <ToolCallStory
      item={THREAD_TOOL_CALL_STORY_ITEMS.fileChange}
      title="File Change / Diff"
      description="Codex Electron-style file-edit tool surface rendered from the canonical file-change item."
      autoOpen
    />
  ),
};

export const FileChangeLivePatchUpdate: Story = {
  render: () => <FileChangeLivePatchUpdateStory />,
};

export const FileChangeVisualizationOnly: Story = {
  render: () => (
    <ToolCallStory
      item={{
        ...THREAD_TOOL_CALL_STORY_ITEMS.fileChange,
        itemId: "tool-call-file-change-visualization-only",
        entryId: "tool-call-file-change-visualization-only",
        status: "inProgress",
        fileChange: {
          changes: {},
          visualizationActivities: [
            {
              path: "/workspace/nodex/.codex/visualizations/thread/chart.html",
              kind: "create",
            },
          ],
          success: null,
        },
      }}
      title="File Change Visualization Only"
      description="Visualization-only patches retain the exact in-progress activity row even when no ordinary file paths remain."
    />
  ),
};

export const FileChangeSingleCompletedAgentActivity: Story = {
  render: () => (
    <StorySurface
      title="File Change Single Completed Activity"
      description="The production projection demotes a settled one-file activity to its ordinary file-change row instead of constructing an unreachable collapsed group."
    >
      <ConversationStorySurface>
        <ProjectedToolActivityScenario id="completed-patch-singleton" />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const FileChangeRepeatedSamePathAgentActivity: Story = {
  render: () => {
    const rawItems = Array.from({ length: 5 }, (_, index) => ({
      type: "fileChange" as const,
      id: `tool-call-file-change-same-path-${index + 1}`,
      status: "completed" as const,
      changes: [
        {
          path: "src/repeated.ts",
          kind: { type: "update" as const, move_path: null },
          diff: [
            "@@ -1 +1 @@",
            `-export const revision = ${index};`,
            `+export const revision = ${index + 1};`,
          ].join("\n"),
        },
      ],
    }));
    const lifecycleStatusByItemId = Object.fromEntries(
      rawItems.map((item) => [item.id, "completed" as const]),
    );

    return (
      <StorySurface
        title="File Change Repeated Same Path"
        description="Critical regression fixture: repeated edits to the same display path summarize as Edited a file, not Edited 5 files."
      >
        <ConversationStorySurface>
          <ProjectedToolActivity
            fixture={buildThreadToolActivityProjectionFixture({
              id: "repeated-file-change-path",
              rawItems,
              turnStatus: "completed",
              lifecycleStatusByItemId,
              isLatestTurn: false,
            })}
          />
        </ConversationStorySurface>
      </StorySurface>
    );
  },
};

export const FileChangePendingApproval: Story = {
  render: () => (
    <ToolCallStory
      item={buildStoryFileChangeItem({
        id: "tool-call-file-change-pending-approval",
        status: "inProgress",
        approvalRequestId: "approval-file-change-story",
        changes: [
          {
            path: "src/pending.ts",
            type: "update",
            movePath: null,
            unifiedDiff: [
              "@@ -1 +1 @@",
              "-export const permission = 'old';",
              "+export const permission = 'pending';",
            ].join("\n"),
          },
        ],
      })}
      title="File Change Pending Approval"
      description="Pending file-change approvals omit the action word in the row header and use the short diff frame height."
      autoOpen
    />
  ),
};

export const FileChangeMultiFile: Story = {
  render: () => (
    <ToolCallStory
      item={(() => {
        const changes: CodexFileChange[] = [
          {
            path: "src/one.ts",
            type: "update",
            movePath: null,
            unifiedDiff: ["@@ -1 +1 @@", "-console.log('one');", "+console.log('ONE');"].join("\n"),
          },
          {
            path: "src/two.ts",
            type: "update",
            movePath: null,
            unifiedDiff: ["@@ -1 +1 @@", "-console.log('two');", "+console.log('TWO');"].join("\n"),
          },
        ];

        return {
          ...THREAD_TOOL_CALL_STORY_ITEMS.fileChange,
          itemId: "tool_story_file_change_multi",
          entryId: "tool_story_file_change_multi",
          fileChange: buildStoryFileChangePayload(changes),
          toolCall: buildStoryFileChangeToolCall(changes),
        };
      })()}
      title="File Change / Diff Multi-File"
      description="Expanded per-file rows keep the thread-owned filename header without repeating the diff library header inside each embedded preview."
      autoOpen
    />
  ),
};

export const FileChangeSemanticFallback: Story = {
  render: () => (
    <ToolCallStory
      item={(() => {
        const changes: CodexFileChange[] = [
          {
            path: "src/new-file.ts",
            type: "add",
            content: "export function Foo() {}\n",
          },
          {
            path: "src/deleted-file.ts",
            type: "delete",
            content: "export function Gone() {}\n",
          },
        ];

        return {
          ...THREAD_TOOL_CALL_STORY_ITEMS.fileChange,
          itemId: "tool-call-file-change-semantic-fallback",
          entryId: "tool-call-file-change-semantic-fallback",
          fileChange: buildStoryFileChangePayload(changes),
          toolCall: buildStoryFileChangeToolCall(changes),
        };
      })()}
      title="File Change Semantic Fallback"
      description="Structured add and delete changes use semantic previews instead of a raw patch text fallback when no parsed inline file diff is available."
      autoOpen
    />
  ),
};

export const FileChangeStoppedUpdate: Story = {
  render: () => (
    <ToolCallStory
      item={buildStoryFileChangeItem({
        id: "tool-call-file-change-stopped-update",
        status: "inProgress",
        changes: [
          {
            path: "src/stopped-update.ts",
            type: "update",
            movePath: null,
            unifiedDiff: [
              "@@ -1 +1 @@",
              "-export const stopped = false;",
              "+export const stopped = true;",
            ].join("\n"),
          },
        ],
      })}
      title="File Change Stopped Update"
      description="Interrupted update rows use stopped editing copy while preserving the ordinary expanded diff body."
      autoOpen
      isTurnCancelled
    />
  ),
};

export const FileChangeStoppedDelete: Story = {
  render: () => (
    <ToolCallStory
      item={buildStoryFileChangeItem({
        id: "tool-call-file-change-stopped-delete",
        status: "inProgress",
        changes: [
          {
            path: "src/stopped-delete.ts",
            type: "delete",
            content: "export const removed = true;\n",
          },
        ],
      })}
      title="File Change Stopped Delete"
      description="Interrupted delete rows use stopped deleting copy and keep the semantic delete fallback body available when expanded."
      autoOpen
      isTurnCancelled
    />
  ),
};

export const FileChangeDeclinedRename: Story = {
  render: () => (
    <ToolCallStory
      item={(() => {
        const changes: CodexFileChange[] = [
          {
            path: "src/original.ts",
            type: "update",
            movePath: "src/renamed.ts",
            unifiedDiff: [
              "@@ -1 +1 @@",
              "-export const value = 'old';",
              "+export const value = 'new';",
            ].join("\n"),
          },
        ];

        return {
          ...THREAD_TOOL_CALL_STORY_ITEMS.fileChange,
          itemId: "tool-call-file-change-declined-rename",
          entryId: "tool-call-file-change-declined-rename",
          status: "declined",
          fileChange: buildStoryFileChangePayload(changes, false),
          toolCall: buildStoryFileChangeToolCall(changes),
        };
      })()}
      title="File Change Declined Rename"
      description="Rejected file edits preserve rename metadata in the renderer and match Codex Electron's plain rejected summary label."
      autoOpen
    />
  ),
};

export const FileChangeAutoReviewStates: Story = {
  render: () => (
    <ToolCallStory
      item={buildStoryFileChangeItem({
        id: "tool-call-file-change-auto-review-states",
        changes: [
          {
            path: "src/auto-review.ts",
            type: "update",
            movePath: null,
            unifiedDiff: [
              "@@ -1 +1 @@",
              "-export const autoReview = 'old';",
              "+export const autoReview = 'new';",
            ].join("\n"),
          },
        ],
      })}
      title="File Change Auto Review States"
      description="Attached auto-review rows use the shared compact Auto-review wording for approved, high-risk denied, and timed-out reviews."
      autoOpen
      automaticApprovalReviews={[
        buildAutoReviewStoryItem("approved", {
          status: "approved",
          riskLevel: "low",
          rationale: "This change stays inside the project workspace.",
        }),
        buildAutoReviewStoryItem("denied-high-risk", {
          status: "denied",
          riskLevel: "high",
          rationale: "This request attempted to edit a protected path.",
        }),
        buildAutoReviewStoryItem("timed-out", {
          status: "timedOut",
          riskLevel: null,
          rationale: null,
        }),
      ]}
    />
  ),
};

export const FileChangeStoppedAutoReview: Story = {
  render: () => (
    <ToolCallStory
      item={(() => {
        const changes: CodexFileChange[] = [
          {
            path: "src/stopped.ts",
            type: "add",
            content: "export const stopped = true;\n",
          },
        ];

        return {
          ...THREAD_TOOL_CALL_STORY_ITEMS.fileChange,
          itemId: "tool-call-file-change-stopped-auto-review",
          entryId: "tool-call-file-change-stopped-auto-review",
          status: "inProgress",
          fileChange: buildStoryFileChangePayload(changes, null),
          toolCall: buildStoryFileChangeToolCall(changes),
        };
      })()}
      title="File Change Stopped With Auto Review"
      description="Interrupted turns render stopped patch copy while attached automatic approval reviews stay inside the patch row."
      autoOpen
      isTurnCancelled
      automaticApprovalReviews={[
        {
          threadId: "thread_tool_story",
          turnId: "turn_tool_story",
          itemId: "automatic-approval-review:story",
          entryId: "automatic-approval-review:story",
          type: "automaticApprovalReview",
          kind: "systemEvent",
          semanticKind: "automaticApprovalReview",
          status: "completed",
          markdownText: "This generated edit touched a protected file.",
          rawItem: {
            targetItemId: "tool-call-file-change-stopped-auto-review",
            review: {
              status: "denied",
              riskLevel: "high",
              userAuthorization: "unknown",
              rationale: "This generated edit touched a protected file.",
            },
            action: null,
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ]}
    />
  ),
};

export const TurnDiff: Story = {
  render: () => (
    <StorySurface
      title="Turn Diff"
      description="Turn-level unified diff rendered separately from the file-edit tool call."
    >
      <ConversationStorySurface>
        <TurnDiffSurface
          item={THREAD_TOOL_CALL_STORY_ITEMS.turnDiff}
          isInProgress={false}
          projectWorkspacePath="/workspace/nodex"
          threadCwd="/workspace/nodex"
          onOpenReview={() => undefined}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const TurnDiffWithRevert: Story = {
  render: () => (
    <StorySurface
      title="Turn Diff With Revert"
      description="Completed turn diffs can hand off directly to the Diffs stage and expose the Codex-style revert/reapply affordance when the payload requests it."
    >
      <ConversationStorySurface>
        <TurnDiffSurface
          item={{
            ...THREAD_TOOL_CALL_STORY_ITEMS.turnDiff,
            rawItem: {
              ...(typeof THREAD_TOOL_CALL_STORY_ITEMS.turnDiff.rawItem === "object" &&
              THREAD_TOOL_CALL_STORY_ITEMS.turnDiff.rawItem !== null
                ? THREAD_TOOL_CALL_STORY_ITEMS.turnDiff.rawItem
                : {}),
              type: "turn-diff",
              cwd: "/workspace/nodex",
              unifiedDiff:
                (
                  THREAD_TOOL_CALL_STORY_ITEMS.turnDiff.rawItem as
                    | { unifiedDiff?: string }
                    | undefined
                )?.unifiedDiff ?? "",
              showRevertButton: true,
            },
          }}
          isInProgress={false}
          projectWorkspacePath="/workspace/nodex"
          threadCwd="/workspace/nodex"
          onOpenReview={() => undefined}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const TurnDiffMultiFileCompleted: Story = {
  render: () => (
    <StorySurface
      title="Turn Diff Edited 12 Files"
      description="Completed turn-diff payload matching the Codex Electron edited-files fixture: 12 files, three visible rows, and Show 9 more files."
    >
      <ConversationStorySurface>
        <TurnDiffSurface
          item={buildTurnDiffItem("turn-diff-multi-file", buildDistributedTurnDiff(12, 467, 348))}
          isInProgress={false}
          projectWorkspacePath="/workspace/nodex"
          threadCwd="/workspace/nodex"
          onOpenReview={() => undefined}
          onOpenFileInSidePanel={() => undefined}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const TurnDiffSingleFile: Story = {
  render: () => (
    <StorySurface
      title="Turn Diff Single File"
      description="Single-file turn-diff card uses the basename in the title and omits the multi-file list."
    >
      <ConversationStorySurface>
        <TurnDiffSurface
          item={buildTurnDiffItem(
            "turn-diff-single-file",
            buildStoryDiffFile("src/renderer/single-file.tsx", 4, 2),
          )}
          isInProgress={false}
          projectWorkspacePath="/workspace/nodex"
          threadCwd="/workspace/nodex"
          onOpenReview={() => undefined}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const TurnDiffLargeDiffFallback: Story = {
  render: () => (
    <StorySurface
      title="Turn Diff Large Diff Fallback"
      description="Inline rendering switches to the large-diff fallback once the Codex threshold estimate exceeds 5000 lines."
    >
      <ConversationStorySurface>
        <TurnDiffSurface
          item={buildTurnDiffItem(
            "turn-diff-large",
            [
              "diff --git a/src/large.ts b/src/large.ts",
              "--- a/src/large.ts",
              "+++ b/src/large.ts",
              "@@ -1,5200 +1,5200 @@",
              ...Array.from(
                { length: 5201 },
                (_, index) => `+export const value${index} = ${index};`,
              ),
              buildStoryDiffFile("src/small.ts", 2, 1),
            ].join("\n"),
          )}
          isInProgress={false}
          projectWorkspacePath="/workspace/nodex"
          threadCwd="/workspace/nodex"
          onOpenReview={() => undefined}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const TurnDiffPatchFailure: Story = {
  render: () => (
    <StorySurface
      title="Turn Diff Patch Failure"
      description="Failure dialog shown when Undo/Reapply cannot apply every path cleanly."
    >
      <ConversationStorySurface>
        <TurnDiffPatchFailureDialog
          failure={{
            action: "undo",
            result: {
              status: "error",
              appliedPaths: ["src/applied.ts"],
              skippedPaths: ["src/skipped.ts"],
              conflictedPaths: ["src/conflict.ts"],
              errorCode: "applyFailed",
              errorMessage: "patch failed",
            },
          }}
          onClose={() => undefined}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const TurnDiffInProgress: Story = {
  render: () => (
    <StorySurface
      title="Turn Diff In Progress"
      description="Streaming turn-diff summary used above the composer while Codex is still working."
    >
      <ConversationStorySurface>
        <TurnDiffSurface
          item={buildTurnDiffItem("turn-diff-in-progress", buildDistributedTurnDiff(4, 34, 18))}
          isInProgress
          projectWorkspacePath="/workspace/nodex"
          threadCwd="/workspace/nodex"
          onOpenReview={() => undefined}
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const WebSearch: Story = {
  render: () => (
    <ToolCallStory
      item={THREAD_TOOL_CALL_STORY_ITEMS.webSearch}
      title="Web Search"
      description="Codex Electron-style compact search summary row showing the primary query without an expandable JSON body."
    />
  ),
};

export const WebSearchFindInPage: Story = {
  render: () => (
    <ToolCallStory
      item={THREAD_TOOL_CALL_STORY_ITEMS.webSearchFindInPage}
      title="Web Search Find In Page"
      description="The dedicated web-search leaf also matches Codex Electron wording for find-in-page actions."
    />
  ),
};

export const ToolCallIconography: Story = {
  render: () => (
    <StorySurface
      title="Tool Call Iconography"
      description="Licensed Codex tool glyphs shown with the thread row sizing and muted token contract."
    >
      <ConversationStorySurface>
        <div className="flex flex-col gap-2 text-size-chat text-token-description-foreground">
          {[
            "run-command",
            "edit-files",
            "web-search",
            "code-searching",
            "list-files",
            "approved",
            "denied",
            "skill",
            "browser-use",
            "computer-use",
            "plugin",
            "connector",
          ].map((icon) => (
            <div key={icon} className="flex items-center gap-2">
              <ToolActivityIcon
                descriptor={semanticToolIcon(icon as Parameters<typeof semanticToolIcon>[0])}
              />
              <span>{icon}</span>
            </div>
          ))}
        </div>
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const WebSearchInProgress: Story = {
  render: () => (
    <ToolCallStory
      item={THREAD_TOOL_CALL_STORY_ITEMS.webSearchInProgress}
      title="Web Search In Progress"
      description="Running web searches shimmer only the top-level active phrase while the detail text remains static."
    />
  ),
};

export const WebSearchCompletedCurrentAgentActivity: Story = {
  render: () => (
    <StorySurface
      title="Web Search Completed Singleton Activity"
      description="The production projection renders a settled web-search singleton as its family row, with no synthetic collapsed group or active shimmer."
    >
      <ConversationStorySurface>
        <ProjectedToolActivityScenario id="completed-web-singleton" />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const McpToolCallDefault: Story = {
  render: () => (
    <ToolCallStory
      item={THREAD_TOOL_CALL_STORY_ITEMS.mcp}
      title="MCP Tool Call"
      description="Expanded Codex-style MCP disclosure with plaintext result content and the raw-output dialog trigger."
      autoOpen
    />
  ),
};

export const McpToolCallCollapsed: Story = {
  render: () => (
    <StorySurface
      title="MCP Tool Call Collapsed"
      description="Collapsed Codex Electron parity state for a completed MCP call."
    >
      <McpToolCall item={THREAD_TOOL_CALL_STORY_ITEMS.mcpQueryDocs} />
    </StorySurface>
  ),
};

export const McpAppInfoSourceLogo: Story = {
  render: () => (
    <StorySurface
      title="MCP AppInfo Source Logo"
      description="Late normalized AppInfo supplies the exact square light/dark source assets without changing transcript state."
    >
      <ThreadMcpAppsProvider apps={MCP_APP_INFO_STORY_APPS}>
        <McpToolCall item={buildMcpAppInfoStoryItem("mcp-app-info-source")} />
      </ThreadMcpAppsProvider>
    </StorySurface>
  ),
};

export const McpBrowserSource: Story = {
  render: () => (
    <StorySurface
      title="MCP Browser Source"
      description="Canonical browser-use source metadata selects the browser glyph and source-specific completed label."
    >
      <McpToolCall
        item={buildMcpSourceStoryItem("mcp-browser-source", { kind: "browserUse", backend: "iab" })}
      />
    </StorySurface>
  ),
};

export const McpChromeBrowserSource: Story = {
  render: () => (
    <StorySurface
      title="MCP Chrome Browser Source"
      description="Chrome browser-use activity uses the exact embedded source identity asset while remaining distinct from native Chrome computer use."
    >
      <McpToolCall
        item={buildMcpSourceStoryItem("mcp-chrome-browser-source", {
          kind: "browserUse",
          backend: "chrome",
        })}
      />
    </StorySurface>
  ),
};

export const McpComputerSource: Story = {
  render: () => (
    <StorySurface
      title="MCP Computer Source"
      description="Canonical computer-use source metadata selects the dedicated computer-use glyph."
    >
      <McpToolCall
        item={buildMcpSourceStoryItem("mcp-computer-source", { kind: "computerUse", app: null })}
      />
    </StorySurface>
  ),
};

export const McpToolCallExpanded: Story = {
  render: () => (
    <StorySurface
      title="MCP Tool Call Expanded"
      description="Expanded Codex Electron parity state for a completed MCP call with visible plaintext result content."
    >
      <AutoOpenMcpToolCall item={THREAD_TOOL_CALL_STORY_ITEMS.mcp} />
    </StorySurface>
  ),
};

export const McpRawOutputDialog: Story = {
  render: () => (
    <StorySurface
      title="MCP Raw Output Dialog"
      description="The raw-output dialog opened from the Codex-style MCP call footer action."
    >
      <AutoOpenMcpToolCall item={THREAD_TOOL_CALL_STORY_ITEMS.mcp} rawDialogOpen />
    </StorySurface>
  ),
};

export const McpToolCallLargePreview: Story = {
  render: () => (
    <StorySurface
      title="MCP Tool Call Large Preview"
      description="A large text result mounts a bounded preview, reports omitted content, and keeps exact text behind View full and Raw."
    >
      <AutoOpenMcpToolCall
        item={buildMcpResultStoryItem("mcp-large-preview", buildLargeMcpTextResult("Result line"))}
      />
    </StorySurface>
  ),
};

export const McpLargeRawOutputDialog: Story = {
  render: () => (
    <StorySurface
      title="MCP Large Raw Output Dialog"
      description="Opening Raw derives the complete payload once and hands it to the lazy viewport-rendered reader."
    >
      <AutoOpenMcpToolCall
        item={buildMcpResultStoryItem("mcp-large-raw", buildLargeMcpTextResult("Raw result line"))}
        rawDialogOpen
      />
    </StorySurface>
  ),
};

export const McpToolCallAppWithAutoReview: Story = {
  render: () => (
    <StorySurface
      title="MCP App With Auto-review"
      description="Attached auto-review rows in the MCP app/card branch render as title-only rows before the app surface."
    >
      <AutoOpenMcpToolCall
        automaticApprovalReviews={[
          buildAutoReviewStoryItem("mcp-app-approved", {
            status: "approved",
            riskLevel: "low",
            rationale: "Only connector UI data is being displayed.",
          }),
        ]}
        item={{
          ...THREAD_TOOL_CALL_STORY_ITEMS.mcp,
          mcpToolCall: THREAD_TOOL_CALL_STORY_ITEMS.mcp.mcpToolCall
            ? {
                ...THREAD_TOOL_CALL_STORY_ITEMS.mcp.mcpToolCall,
                mcpAppResourceUri: "ui://context7/docs",
                result: {
                  type: "success",
                  content: [],
                  structuredContent: null,
                  raw: {
                    content: [],
                    structuredContent: null,
                    _meta: null,
                  },
                },
              }
            : THREAD_TOOL_CALL_STORY_ITEMS.mcp.mcpToolCall,
        }}
      />
    </StorySurface>
  ),
};

export const McpToolCallInProgress: Story = {
  render: () => (
    <StorySurface
      title="MCP Tool Call In Progress"
      description="In-progress MCP calls stay collapsed and shimmer only the label text; source logos remain static."
    >
      <McpToolCall item={THREAD_TOOL_CALL_STORY_ITEMS.mcpInProgress} />
    </StorySurface>
  ),
};

export const McpToolCallInProgressWithResult: Story = {
  render: () => (
    <StorySurface
      title="MCP Tool Call In Progress With Result"
      description="In-progress MCP calls become expandable as soon as a result exists, matching the standalone disclosure boundary."
    >
      <McpToolCall item={THREAD_TOOL_CALL_STORY_ITEMS.mcpInProgressWithResult} />
    </StorySurface>
  ),
};

export const McpToolCallProtocolError: Story = {
  render: () => (
    <StorySurface
      title="MCP Tool Call Protocol Error"
      description="Completed protocol errors render the error branch instead of the no-content fallback."
    >
      <AutoOpenMcpToolCall item={THREAD_TOOL_CALL_STORY_ITEMS.mcpProtocolError} />
    </StorySurface>
  ),
};

export const McpToolCallStructuredOnly: Story = {
  render: () => (
    <StorySurface
      title="MCP Tool Call Structured Only"
      description="Structured-only success renders the JSON panel directly without the no-content fallback."
    >
      <AutoOpenMcpToolCall item={THREAD_TOOL_CALL_STORY_ITEMS.mcpQueryDocs} />
    </StorySurface>
  ),
};

export const McpToolCallRareContentBlocks: Story = {
  render: () => (
    <StorySurface
      title="MCP Tool Call Rare Content Blocks"
      description="Exact cJn coverage for annotated text, resource links, embedded resources, image data, and audio data in one expanded successful result."
    >
      <AutoOpenMcpToolCall
        item={buildMcpResultStoryItem("mcp-rare-content-blocks", {
          type: "success",
          content: MCP_RARE_CONTENT_BLOCKS,
          structuredContent: null,
          raw: {
            content: JSON.parse(JSON.stringify(MCP_RARE_CONTENT_BLOCKS)),
            structuredContent: null,
            _meta: null,
          },
        })}
      />
    </StorySurface>
  ),
};

export const McpToolCallNoContent: Story = {
  render: () => (
    <StorySurface
      title="MCP Tool Call No Content"
      description="A completed success with no content and no structured payload reaches the exact Tool returned no content fallback."
    >
      <AutoOpenMcpToolCall
        item={buildMcpResultStoryItem("mcp-no-content", {
          type: "success",
          content: [],
          structuredContent: null,
          raw: { content: [], structuredContent: null, _meta: null },
        })}
      />
    </StorySurface>
  ),
};

export const McpToolCallUnknownBlock: Story = {
  render: () => (
    <StorySurface
      title="MCP Tool Call Unknown Block"
      description="Malformed content blocks fall back to visible JSON instead of disappearing."
    >
      <AutoOpenMcpToolCall item={THREAD_TOOL_CALL_STORY_ITEMS.mcpUnknownBlock} />
    </StorySurface>
  ),
};

export const ReasoningOnlyLiveActivity: Story = {
  render: () => (
    <StorySurface
      title="Reasoning-only Live Activity"
      description="A raw reasoning summary with no visible tool is projected into the single standalone live-activity owner."
    >
      <ConversationStorySurface>
        <ProjectedToolActivityScenario id="reasoning-only" />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const EmptyPatchBeforeMaterialization: Story = {
  render: () => (
    <StorySurface
      title="Empty Patch Before Materialization"
      description="An in-progress fileChange lifecycle with no materialized changes produces no tool row; the reasoning summary remains the live owner."
    >
      <ConversationStorySurface>
        <ProjectedToolActivityScenario id="pre-patch" />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const MixedToolActivityWithReasoningBoundaries: Story = {
  render: () => (
    <StorySurface
      title="Mixed Tool Activity with Reasoning Boundaries"
      description="Raw command, reasoning, patch, reasoning, and web-search items pass through the production projector; hidden reasoning does not split the group or replace its active web label."
    >
      <ConversationStorySurface>
        <ProjectedToolActivityScenario id="mixed-tools" />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const ActiveStandaloneDynamicActivity: Story = {
  render: () => (
    <StorySurface
      title="Active Standalone Dynamic Activity"
      description="A registry-declared standalone handoff call stays on its rich dynamic surface and does not acquire an ordinary activity-group wrapper."
    >
      <ConversationStorySurface>
        <ProjectedToolActivityScenario id="active-standalone-dynamic" />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const AgentActivityGroup: Story = {
  render: () => (
    <StorySurface
      title="Collapsed Activity Group"
      description="Codex-style grouped activity row preserves original tool units inside a flat Motion body."
    >
      <ConversationStorySurface>
        <ProjectedToolActivityScenario id="settled-mixed-tools" />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const AgentActivityGroupExpanded: Story = {
  render: () => (
    <StorySurface
      title="Collapsed Activity Group Expanded"
      description="Expanded production-projected activity groups keep readable conversation-body text and family/source-aware leading icons across command, patch, web, MCP, and dynamic rows."
    >
      <ConversationStorySurface>
        <ProjectedToolActivityScenario id="settled-mixed-tools" autoOpen />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const AgentActivityGroupCommandActions: Story = {
  render: () => (
    <StorySurface
      title="Command Activity Summaries"
      description="Read, search, list, and shell summaries share one text tone; file references keep their independent hover and open actions."
    >
      <ConversationStorySurface>
        <ProjectedToolActivity
          fixture={buildThreadToolActivityProjectionFixture({
            id: "command-activity-summaries",
            rawItems: [agentActivityV2MultiActionCommandItem, agentActivityV2FallbackCommandItem],
            turnStatus: "completed",
            isLatestTurn: false,
          })}
          autoOpen
        />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const AgentActivityGroupLiveFileChange: Story = {
  render: () => (
    <StorySurface
      title="Collapsed Activity Group Live File Change"
      description="Matches Codex Electron's live patchUpdated fixture: a single in-progress file edit owns the collapsed activity header and animated +85/-0 digit stack."
    >
      <ConversationStorySurface>
        <ProjectedToolActivityScenario id="materialized-patch" />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const AgentActivityGroupOwnsThinking: Story = {
  render: () => (
    <StorySurface
      title="Collapsed Activity Group Owns Thinking"
      description="The latest open activity group carries the live Thinking fallback in its header without adding a second transcript row."
    >
      <ConversationStorySurface>
        <ProjectedToolActivityScenario id="thinking-owner" />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

function buildReadThreadDynamicStoryItem(): CodexTranscriptEntry {
  return {
    threadId: "thread-story",
    turnId: "turn-story",
    itemId: "dynamic-read-thread",
    entryId: "dynamic-read-thread",
    type: "dynamicToolCall",
    kind: "toolCall",
    semanticKind: "dynamicToolCall",
    status: "completed",
    toolCall: {
      subtype: "dynamic",
      toolName: "read_thread",
      server: "codex_app",
      args: { threadId: "thread-story", turnLimit: 2 },
      result: [{ type: "inputText", text: '{"schemaVersion":1}' }],
    },
    dynamicToolCall: {
      callId: "dynamic-read-thread",
      namespace: "codex_app",
      tool: "read_thread",
      arguments: { threadId: "thread-story", turnLimit: 2 },
      status: "completed",
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            schemaVersion: 1,
            thread: { id: "thread-story", title: "Parity research", cwd: "/workspace/nodex" },
            page: { order: "newest_first", limit: 2, nextCursor: null, hasMore: false },
            turns: [],
          }),
        },
      ],
      success: true,
      durationMs: 18,
      completed: true,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function buildCodexAppMetaDynamicStoryItem(input: {
  id: string;
  tool: string;
  completed: boolean;
  success?: boolean | null;
  args?: unknown;
  contentText?: string;
}): CodexTranscriptEntry {
  return {
    ...buildReadThreadDynamicStoryItem(),
    itemId: input.id,
    entryId: input.id,
    status: input.completed ? "completed" : "inProgress",
    toolCall: {
      subtype: "dynamic",
      toolName: input.tool,
      server: "codex_app",
      args: input.args ?? {},
      result: input.contentText ? [{ type: "inputText", text: input.contentText }] : undefined,
    },
    dynamicToolCall: {
      callId: input.id,
      namespace: "codex_app",
      tool: input.tool,
      arguments: input.args ?? {},
      status: input.completed ? "completed" : "inProgress",
      contentItems: input.contentText ? [{ type: "inputText", text: input.contentText }] : null,
      success: input.success ?? (input.completed ? true : null),
      durationMs: input.completed ? 18 : null,
      completed: input.completed,
    },
  };
}

function buildGenericDynamicStoryItem(input: {
  id: string;
  namespace: string;
  tool: string;
  completed: boolean;
  args?: unknown;
  contentText?: string;
}): CodexTranscriptEntry {
  return {
    ...buildReadThreadDynamicStoryItem(),
    itemId: input.id,
    entryId: input.id,
    status: input.completed ? "completed" : "inProgress",
    toolCall: {
      subtype: "dynamic",
      toolName: input.tool,
      server: input.namespace,
      args: input.args ?? {},
      result: input.contentText ? [{ type: "inputText", text: input.contentText }] : undefined,
    },
    dynamicToolCall: {
      callId: input.id,
      namespace: input.namespace,
      tool: input.tool,
      arguments: input.args ?? {},
      status: input.completed ? "completed" : "inProgress",
      contentItems: input.contentText ? [{ type: "inputText", text: input.contentText }] : null,
      success: input.completed ? true : null,
      durationMs: input.completed ? 18 : null,
      completed: input.completed,
    },
  };
}

function buildDynamicAudioStoryItem(): CodexTranscriptEntry {
  const contentItems = [
    {
      type: "inputAudio" as const,
      audioUrl:
        "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
    },
  ];
  const item = buildGenericDynamicStoryItem({
    id: "fallback-audio-output",
    namespace: "example_connector",
    tool: "render_audio",
    completed: true,
  });
  if (!item.toolCall || !item.dynamicToolCall) {
    throw new Error("Dynamic audio story requires dynamic tool payloads");
  }
  return {
    ...item,
    toolCall: { ...item.toolCall, result: contentItems },
    dynamicToolCall: { ...item.dynamicToolCall, contentItems },
  };
}

export const DynamicToolCallReadThread: Story = {
  render: () => (
    <StorySurface
      title="Dynamic Tool Call Read Thread"
      description="Codex app-server dynamic thread tools render as compact Codex rows."
    >
      <ConversationStorySurface>
        <DynamicToolCall item={buildReadThreadDynamicStoryItem()} />
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const CodexAppMetaThreadTools: Story = {
  render: () => (
    <StorySurface
      title="Codex App Meta Thread Tools"
      description="Parity fixture for codex_app thread control rows and create-thread success cards."
    >
      <ConversationStorySurface>
        <div className="flex flex-col gap-1">
          <DynamicToolCall
            item={buildCodexAppMetaDynamicStoryItem({
              id: "create-active",
              tool: "create_thread",
              completed: false,
              args: { prompt: "Background follow-up", target: { type: "projectless" } },
            })}
          />
          <DynamicToolCall
            item={buildCodexAppMetaDynamicStoryItem({
              id: "create-completed",
              tool: "create_thread",
              completed: true,
              args: { prompt: "Background follow-up", target: { type: "projectless" } },
              contentText: '{"threadId":"thread-created"}',
            })}
          />
          <DynamicToolCall
            item={buildCodexAppMetaDynamicStoryItem({
              id: "create-worktree",
              tool: "create_thread",
              completed: true,
              args: {
                prompt: "Worktree follow-up",
                target: {
                  type: "project",
                  projectId: "project-1",
                  environment: { type: "worktree" },
                },
              },
              contentText:
                '{"clientThreadId":"client-new-thread:11111111-1111-4111-8111-111111111111"}',
            })}
          />
          <DynamicToolCall
            item={buildCodexAppMetaDynamicStoryItem({
              id: "fork-worktree",
              tool: "fork_thread",
              completed: false,
              args: { environment: { type: "worktree" } },
            })}
          />
          <DynamicToolCall
            item={buildCodexAppMetaDynamicStoryItem({
              id: "list-threads",
              tool: "list_threads",
              completed: false,
            })}
          />
          <DynamicToolCall
            item={buildCodexAppMetaDynamicStoryItem({
              id: "read-thread",
              tool: "read_thread",
              completed: true,
              args: { threadId: "thread-story" },
            })}
            onOpenThread={() => {}}
          />
          <DynamicToolCall
            item={buildCodexAppMetaDynamicStoryItem({
              id: "send-thread",
              tool: "send_message_to_thread",
              completed: true,
              args: { threadId: "thread-story" },
            })}
            onOpenThread={() => {}}
          />
          <DynamicToolCall
            item={buildCodexAppMetaDynamicStoryItem({
              id: "handoff-status",
              tool: "get_handoff_status",
              completed: true,
              args: { operationId: "handoff-1" },
            })}
          />
          <DynamicToolCall
            item={buildCodexAppMetaDynamicStoryItem({
              id: "pin-thread",
              tool: "set_thread_pinned",
              completed: true,
            })}
          />
          <DynamicToolCall
            item={buildCodexAppMetaDynamicStoryItem({
              id: "archive-thread",
              tool: "set_thread_archived",
              completed: false,
            })}
          />
          <DynamicToolCall
            item={buildCodexAppMetaDynamicStoryItem({
              id: "title-thread",
              tool: "set_thread_title",
              completed: true,
            })}
          />
        </div>
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const DynamicToolRegistryRenderers: Story = {
  render: () => (
    <StorySurface
      title="Dynamic Tool Registry Renderers"
      description="Non-thread registry renderers use their registered labels and icons instead of generic humanized fallback rows."
    >
      <ConversationStorySurface>
        <div className="flex flex-col gap-1">
          <DynamicToolCall
            item={buildGenericDynamicStoryItem({
              id: "settings-read-active",
              namespace: "codex_app",
              tool: "read_settings",
              completed: false,
            })}
          />
          <DynamicToolCall
            item={buildGenericDynamicStoryItem({
              id: "settings-write-completed",
              namespace: "codex_app",
              tool: "write_settings",
              completed: true,
            })}
          />
          <DynamicToolCall
            item={buildGenericDynamicStoryItem({
              id: "chrome-tab-context-active",
              namespace: "chrome_extension",
              tool: "get_tab_context",
              completed: false,
              args: { tabId: 8 },
            })}
          />
          <DynamicToolCall
            item={buildGenericDynamicStoryItem({
              id: "chrome-tab-context-invalid",
              namespace: "chrome_extension",
              tool: "get_tab_context",
              completed: true,
              args: { tabId: -1 },
            })}
          />
          <HandoffStoryExample
            operation={buildStoryHandoffOperation("handoff-running-steps", "running")}
          />
        </div>
      </ConversationStorySurface>
    </StorySurface>
  ),
};

function buildStoryHandoffOperation(id: string, status: CodexAppHandoffOperation["status"]) {
  return buildThreadHandoffOperation({
    operationId: id,
    requestThreadId: "thread-story",
    sourceThreadId: "thread-target-story",
    threadId: "thread-target-story",
    threadTitle: "Audit worktree lifecycle",
    destinationHostDisplayName: "Build box",
    direction: "cross-host",
    status,
    steps: [
      {
        id: "prepare-host-transfer",
        label: "Preparing files for transfer",
        status: "success",
        message: null,
        updatedAt: 1,
      },
      {
        id: "transfer-host-artifacts",
        label: "Copying files to the destination host",
        status: status === "running" || status === "error" ? status : "success",
        message: null,
        updatedAt: 2,
      },
      ...(status === "success" || status === "warning"
        ? [
            {
              id: "switching-thread",
              label: "Moving chat to the destination worktree",
              status,
              message: null,
              updatedAt: 3,
            },
          ]
        : []),
    ],
  });
}

function HandoffStoryRuntime({
  operations,
  children,
}: {
  operations: readonly CodexAppHandoffOperation[];
  children: ReactNode;
}) {
  const [fixture] = useState(() => {
    let snapshot: CodexThreadHandoffSnapshot = { revision: 1, operations };
    let deliver: (value: CodexThreadHandoffSnapshot) => void = () => undefined;
    const store = createThreadHandoffStore({
      read: async () => snapshot,
      subscribe: (listener) => {
        deliver = listener;
        return () => {
          deliver = () => undefined;
        };
      },
    });
    return {
      store,
      publish: (next: readonly CodexAppHandoffOperation[]) => {
        snapshot = { revision: snapshot.revision + 1, operations: next };
        deliver(snapshot);
      },
    };
  });
  useEffect(() => {
    fixture.publish(operations);
  }, [fixture, operations]);
  return <ThreadHandoffStoreProvider value={fixture.store}>{children}</ThreadHandoffStoreProvider>;
}

function buildHandoffStoryItem(id: string) {
  return buildGenericDynamicStoryItem({
    id,
    namespace: "codex_app",
    tool: "handoff_thread",
    completed: true,
    args: { threadId: "thread-target-story" },
    contentText: JSON.stringify({
      destinationHostDisplayName: "Build box",
      operationId: id,
      status: "queued",
      threadTitle: "Audit worktree lifecycle",
    }),
  });
}

function HandoffStoryExample({ operation }: { operation: CodexAppHandoffOperation }) {
  return (
    <HandoffStoryRuntime operations={[operation]}>
      <DynamicToolCall item={buildHandoffStoryItem(operation.operationId)} />
    </HandoffStoryRuntime>
  );
}

export const HandoffProgressStates: Story = {
  render: () => (
    <StorySurface
      title="Task handoff progress"
      description="The original tool reply follows live Git progress, success, recoverable warnings, and failures from the operation owner."
    >
      <ConversationStorySurface>
        <div className="flex flex-col gap-3">
          <HandoffStoryRuntime operations={[]}>
            <DynamicToolCall item={buildHandoffStoryItem("handoff-queued")} />
          </HandoffStoryRuntime>
          {(["running", "success", "warning", "error"] as const).map((status) => (
            <HandoffStoryExample
              key={status}
              operation={buildStoryHandoffOperation(`handoff-${status}`, status)}
            />
          ))}
        </div>
      </ConversationStorySurface>
    </StorySurface>
  ),
};

function HandoffLiveLifecycleStory() {
  const [phase, setPhase] = useState<"waiting" | "running" | "success">("waiting");
  const [item] = useState(() => buildHandoffStoryItem("handoff-live-lifecycle"));
  const operations =
    phase === "waiting" ? [] : [buildStoryHandoffOperation("handoff-live-lifecycle", phase)];
  return (
    <StorySurface
      title="Live handoff lifecycle"
      description="Publish operation steps after the initial reply, then settle the operation while retaining the same original tool call."
    >
      <div className="mb-3 flex gap-2">
        <button
          type="button"
          className="rounded-md px-2 py-1 text-sm hover:bg-token-list-hover-background"
          onClick={() => setPhase("running")}
        >
          Publish running steps
        </button>
        <button
          type="button"
          className="rounded-md px-2 py-1 text-sm hover:bg-token-list-hover-background"
          onClick={() => setPhase("success")}
        >
          Complete handoff
        </button>
        <button
          type="button"
          className="rounded-md px-2 py-1 text-sm hover:bg-token-list-hover-background"
          onClick={() => setPhase("waiting")}
        >
          Reset
        </button>
      </div>
      <ConversationStorySurface>
        <HandoffStoryRuntime operations={operations}>
          <DynamicToolCall item={item} />
        </HandoffStoryRuntime>
      </ConversationStorySurface>
    </StorySurface>
  );
}

export const HandoffLiveLifecycle: Story = { render: () => <HandoffLiveLifecycleStory /> };

export const DynamicToolCallFallbackRows: Story = {
  render: () => (
    <StorySurface
      title="Dynamic Tool Call Fallback Rows"
      description="Generic dynamic tools use compact activity labels; specialised tools own their content."
    >
      <ConversationStorySurface>
        <div className="flex flex-col gap-1">
          <DynamicToolCall
            item={buildGenericDynamicStoryItem({
              id: "fallback-load-workspace-dependencies",
              namespace: "codex_app",
              tool: "load_workspace_dependencies",
              completed: true,
              args: { includeLibraries: true },
              contentText: '{"node":"/tmp/node"}',
            })}
          />
          <DynamicToolCall
            item={buildGenericDynamicStoryItem({
              id: "fallback-automation-update",
              namespace: "codex_app",
              tool: "automation_update",
              completed: false,
              args: { action: "install" },
            })}
          />
          <DynamicToolCall
            item={buildGenericDynamicStoryItem({
              id: "fallback-external-tool",
              namespace: "example_connector",
              tool: "inspect_project_graph",
              completed: true,
              args: { depth: 2 },
              contentText: "done",
            })}
          />
          <DynamicToolCall item={buildDynamicAudioStoryItem()} />
        </div>
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const NodexDynamicToolCalls: Story = {
  render: () => (
    <StorySurface
      title="Nodex Dynamic Tool Calls"
      description="Nodex calls keep search intent, Page targets, and destinations visible when compact; Nested Markdown edits retain their dedicated inline diff."
    >
      <ConversationStorySurface>
        <div className="flex flex-col gap-3">
          <DynamicToolCall
            item={buildGenericDynamicStoryItem({
              id: "nodex-search",
              namespace: "nodex_app",
              tool: "search",
              completed: true,
              args: { query: "migrtion", target: "pages", scope: { kind: "project" } },
              contentText: JSON.stringify({
                schemaVersion: 1,
                data: {
                  target: "pages",
                  results: [
                    { kind: "page", blockId: "card-1", title: "Migration plan" },
                    { kind: "page", blockId: "card-2", title: "Migration checklist" },
                  ],
                },
              }),
            })}
          />
          <DynamicToolCall
            item={buildGenericDynamicStoryItem({
              id: "nodex-create-cards",
              namespace: "nodex_app",
              tool: "create_pages",
              completed: true,
              args: {
                destination: { kind: "library" },
                pages: [
                  {
                    title: "Migration plan",
                    markdown: "# Migration plan\n\n## Checklist\n- [ ] Back up data",
                  },
                ],
              },
              contentText: JSON.stringify({
                data: {
                  pages: [
                    {
                      pageId: "card-migration-plan",
                      location: { kind: "library", libraryId: "library-story" },
                      bodyBlocksCreated: 3,
                    },
                  ],
                  created: 1,
                },
              }),
            })}
          />
          <DynamicToolCall
            item={buildGenericDynamicStoryItem({
              id: "nodex-update-card",
              namespace: "nodex_app",
              tool: "update_page",
              completed: true,
              args: {
                pageId: "card-migration-plan",
                body: {
                  kind: "patch",
                  patches: [
                    {
                      oldMarkdown: "## Draft\n- [ ] Back up data",
                      newMarkdown: "## Ready\n- [x] Back up data",
                    },
                    {
                      oldMarkdown: "Owner: TBD",
                      newMarkdown: "Owner: Ada",
                    },
                  ],
                },
              },
              contentText: JSON.stringify({
                data: {
                  pageId: "card-migration-plan",
                  effects: {
                    created: 0,
                    updated: 3,
                    moved: 0,
                    deleted: 0,
                  },
                },
              }),
            })}
          />
        </div>
      </ConversationStorySurface>
    </StorySurface>
  ),
};

export const DynamicToolCallAutomationUpdatePages: Story = {
  render: () => (
    <StorySurface
      title="Dynamic Tool Call Automation Update Cards"
      description="automation_update calls render Scheduled task cards with proposal and saved states."
    >
      <ConversationStorySurface>
        <DynamicToolQueryStoryProvider>
          <div className="flex flex-col gap-2">
            <DynamicToolCall
              item={buildCodexAppMetaDynamicStoryItem({
                id: "automation-suggested-create",
                tool: "automation_update",
                completed: true,
                args: {
                  mode: "suggested_create",
                  kind: "cron",
                  status: "ACTIVE",
                  name: "Review release notes",
                  prompt: "Review release notes and summarize risks.",
                  rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
                  cwds: "/Users/asc/repo/nodex",
                  executionEnvironment: "worktree",
                  localEnvironmentConfigPath: null,
                  model: "gpt-5-codex",
                  reasoningEffort: "medium",
                },
              })}
            />
            <DynamicToolCall
              item={buildCodexAppMetaDynamicStoryItem({
                id: "automation-suggested-update",
                tool: "automation_update",
                completed: true,
                args: {
                  mode: "suggested_update",
                  id: "automation-standup",
                  kind: "cron",
                  status: "ACTIVE",
                  name: "Morning standup",
                  prompt: "Summarize overnight changes and blockers.",
                  rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0",
                  cwds: ["/Users/asc/repo/nodex"],
                  executionEnvironment: "worktree",
                  localEnvironmentConfigPath: null,
                  model: "gpt-5-codex",
                  reasoningEffort: "medium",
                },
              })}
            />
            <DynamicToolCall
              item={buildCodexAppMetaDynamicStoryItem({
                id: "automation-created",
                tool: "automation_update",
                completed: true,
                args: {
                  mode: "create",
                  kind: "cron",
                  status: "ACTIVE",
                  name: "Release notes",
                  prompt: "Review release notes.",
                  rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
                  cwds: ["/Users/asc/repo/nodex"],
                  executionEnvironment: "worktree",
                  localEnvironmentConfigPath: null,
                  model: "gpt-5-codex",
                  reasoningEffort: "medium",
                },
                contentText: '{"automationId":"automation-release","mode":"create"}',
              })}
              onOpenSummaryScheduledAutomation={() => undefined}
            />
          </div>
        </DynamicToolQueryStoryProvider>
      </ConversationStorySurface>
    </StorySurface>
  ),
};

function CrossThemeLeafMatrixRow({ children, family }: { children: ReactNode; family: string }) {
  return (
    <section
      className="border-t-[0.5px] border-token-border py-3 first:border-t-0"
      data-cross-theme-leaf-family={family}
    >
      <div className="mb-1.5 text-xs font-medium text-token-description-foreground">{family}</div>
      {children}
    </section>
  );
}

function AutoOpenCrossThemeToolLeaf({ item }: { item: CodexTranscriptEntry }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const ToolComponent = getToolComponent(item);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const frameId = window.requestAnimationFrame(() => {
      const disclosure = root.querySelector<HTMLElement>(
        'button[aria-expanded="false"], [data-file-change-row-header]',
      );
      disclosure?.click();
    });

    return () => window.cancelAnimationFrame(frameId);
  }, []);

  if (!ToolComponent) return null;

  return (
    <div ref={containerRef}>
      <ToolComponent
        item={item}
        projectWorkspacePath="/workspace/nodex"
        threadCwd="/workspace/nodex"
        isStreamingTurn={false}
      />
    </div>
  );
}

function CrossThemeLeafBodyMatrix() {
  const createdTask = buildCodexAppMetaDynamicStoryItem({
    id: "cross-theme-created-task",
    tool: "create_thread",
    completed: true,
    args: { prompt: "Review the parity evidence", target: { type: "projectless" } },
    contentText: '{"threadId":"thread-cross-theme"}',
  });

  return (
    <main
      className="min-h-screen bg-(--background) text-(--foreground)"
      data-testid="cross-theme-leaf-body-matrix"
    >
      <div className="mx-auto max-w-3xl">
        <header className="mb-2">
          <h1 className="text-sm font-medium">Tool activity leaf-body matrix</h1>
          <p className="mt-0.5 text-xs text-token-description-foreground">
            Switch the Storybook theme between Light and Dark to review the core groupable families
            on the production renderer.
          </p>
        </header>

        <ConversationStorySurface>
          <CrossThemeLeafMatrixRow family="Activity group body">
            <ProjectedToolActivityScenario id="settled-mixed-tools" autoOpen />
          </CrossThemeLeafMatrixRow>

          <CrossThemeLeafMatrixRow family="Command output">
            <AutoOpenCrossThemeToolLeaf
              item={buildCommandItem({
                itemId: "cross-theme-command-output",
                entryId: "cross-theme-command-output",
                command: "pnpm test --runInBand",
                commandActions: [],
                aggregatedOutput: "Test Files  42 passed\nTests  317 passed\n",
                exitCode: 0,
                durationMs: 2_400,
              })}
            />
          </CrossThemeLeafMatrixRow>

          <CrossThemeLeafMatrixRow family="File change diff">
            <AutoOpenCrossThemeToolLeaf item={THREAD_TOOL_CALL_STORY_ITEMS.fileChange} />
          </CrossThemeLeafMatrixRow>

          <CrossThemeLeafMatrixRow family="Web search (summary-only by bundle)">
            <AutoOpenCrossThemeToolLeaf item={THREAD_TOOL_CALL_STORY_ITEMS.webSearch} />
          </CrossThemeLeafMatrixRow>

          <CrossThemeLeafMatrixRow family="MCP result and raw-output affordance">
            <AutoOpenCrossThemeToolLeaf item={THREAD_TOOL_CALL_STORY_ITEMS.mcp} />
          </CrossThemeLeafMatrixRow>

          <CrossThemeLeafMatrixRow family="Dynamic summary rows and resource cards">
            <div className="flex flex-col gap-1">
              <DynamicToolCall item={buildReadThreadDynamicStoryItem()} />
              <DynamicToolCall item={createdTask} />
            </div>
          </CrossThemeLeafMatrixRow>
        </ConversationStorySurface>
      </div>
    </main>
  );
}

export const CrossThemeLeafBodies: Story = {
  render: () => <CrossThemeLeafBodyMatrix />,
  parameters: {
    docs: {
      description: {
        story:
          "One production-renderer canvas for light/dark screenshot review of the group, command, patch, web, MCP, and dynamic leaf bodies.",
      },
    },
  },
};

function buildWebMcpStoryItem(): CodexTranscriptEntry {
  const base = buildMcpSourceStoryItem("webmcp-browser-js", { kind: "browserUse", backend: "iab" });
  if (!base.mcpToolCall) return base;
  return {
    ...base,
    mcpToolCall: {
      ...base.mcpToolCall,
      completed: true,
      invocation: {
        server: "node_repl",
        tool: "js",
        arguments: { title: "Search the website catalog" },
      },
      result: {
        type: "success",
        content: [{ type: "text", text: "Found three matching products." }],
        structuredContent: null,
        raw: {
          content: [{ type: "text", text: "Found three matching products." }],
          structuredContent: null,
          _meta: {
            "codex/toolSurface": {
              kind: "browserUse",
              backend: "iab",
              screenshot: { pageUrl: "https://example.com/catalog" },
              webMcpCalls: [
                {
                  kind: "listTools",
                  name: "webmcp_list_tools",
                  outputJson: '[{"name":"search_catalog","description":"Search products"}]',
                },
                {
                  kind: "invokeTool",
                  name: "search_catalog",
                  title: "Search catalog",
                  sourceHostname: "example.com",
                  description: "Search products in the website catalog",
                  readOnlyHint: true,
                  inputJson: '{"query":"desk lamp"}',
                  outputJson: '[{"name":"Arc lamp","price":49},{"name":"Task lamp","price":79}]',
                },
                {
                  kind: "invokeTool",
                  name: "get_product_reviews",
                  sourceHostname: "example.com",
                  inputJson: '{"productIds":[1,2,3,…',
                  inputTruncated: true,
                  outputJson: '{"reviews":[{"rating":5,"text":"A warm, adjustable light…',
                  outputTruncated: true,
                },
                {
                  kind: "invokeTool",
                  name: "search_github_issues",
                  title: "Search repository issues",
                  sourceHostname: "github.com",
                  inputJson: '{"query":"website catalog"}',
                  outputJson: '{"count":4}',
                },
              ],
            },
          },
        },
      },
    },
  };
}

export const WebMcpWebsiteTools: Story = {
  render: () => (
    <ConversationStorySurface>
      <McpToolCall item={buildWebMcpStoryItem()} />
    </ConversationStorySurface>
  ),
};
