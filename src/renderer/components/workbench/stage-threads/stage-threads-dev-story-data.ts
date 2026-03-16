import type {
  CodexCollaborationModeKind,
  CodexConnectionState,
  CodexItemView,
  CodexPermissionMode,
  CodexThreadDetail,
  CodexTurnSummary,
} from "../../../lib/types";

export type StageThreadsStoryThreadMode = "none" | "idle" | "running";
export type StageThreadsStoryAccountMode = "loggedOut" | "pendingLogin" | "apiKey" | "chatgpt";
export type StageThreadsStoryThreadStartProgressMode = "none" | "creating" | "runningSetup" | "failed";

export interface StageThreadsStoryControls {
  threadMode: StageThreadsStoryThreadMode;
  isNewThreadTab: boolean;
  hasNewThreadTarget: boolean;
  threadStartProgressMode: StageThreadsStoryThreadStartProgressMode;
  hideThinkingWhenDone: boolean;
  showApprovals: boolean;
  showUserInput: boolean;
  collaborationMode: CodexCollaborationModeKind;
  hasCollaborationModes: boolean;
  permissionMode: CodexPermissionMode;
  connectionStatus: CodexConnectionState["status"];
  accountMode: StageThreadsStoryAccountMode;
}

export interface StageThreadsStoryPreset {
  id: string;
  name: string;
  description: string;
  controls: StageThreadsStoryControls;
}

export const STAGE_THREADS_STORY_THREAD_MODES = ["none", "idle", "running"] as const;
export const STAGE_THREADS_STORY_THREAD_START_PROGRESS_MODES = ["none", "creating", "runningSetup", "failed"] as const;
export const STAGE_THREADS_STORY_CONNECTION_STATUSES = ["connected", "starting", "disconnected", "missingBinary", "error"] as const;
export const STAGE_THREADS_STORY_ACCOUNT_MODES = ["loggedOut", "pendingLogin", "apiKey", "chatgpt"] as const;
export const STAGE_THREADS_STORY_COLLABORATION_MODES = ["default", "plan"] as const;
export const STAGE_THREADS_STORY_PERMISSION_MODES = ["sandbox", "full-access", "custom"] as const;

export const STAGE_THREADS_STORY_PRESETS: StageThreadsStoryPreset[] = [
  {
    id: "overview",
    name: "Overview",
    description: "Idle thread with full transcript and all tool card variants.",
    controls: {
      threadMode: "idle",
      isNewThreadTab: false,
      hasNewThreadTarget: true,
      threadStartProgressMode: "none",
      hideThinkingWhenDone: false,
      showApprovals: true,
      showUserInput: true,
      collaborationMode: "default",
      hasCollaborationModes: true,
      permissionMode: "sandbox",
      connectionStatus: "connected",
      accountMode: "chatgpt",
    },
  },
  {
    id: "running",
    name: "Running",
    description: "In-progress turn with active footer and stop button behavior.",
    controls: {
      threadMode: "running",
      isNewThreadTab: false,
      hasNewThreadTarget: true,
      threadStartProgressMode: "none",
      hideThinkingWhenDone: true,
      showApprovals: false,
      showUserInput: false,
      collaborationMode: "default",
      hasCollaborationModes: true,
      permissionMode: "full-access",
      connectionStatus: "connected",
      accountMode: "apiKey",
    },
  },
  {
    id: "plan-clarifying",
    name: "Plan Clarifying",
    description: "Plan mode selected with user-input cards to validate clarifying-question UX.",
    controls: {
      threadMode: "running",
      isNewThreadTab: false,
      hasNewThreadTarget: true,
      threadStartProgressMode: "none",
      hideThinkingWhenDone: false,
      showApprovals: false,
      showUserInput: true,
      collaborationMode: "plan",
      hasCollaborationModes: true,
      permissionMode: "sandbox",
      connectionStatus: "connected",
      accountMode: "chatgpt",
    },
  },
  {
    id: "new-thread",
    name: "New Thread",
    description: "First-prompt tab state with target card context.",
    controls: {
      threadMode: "none",
      isNewThreadTab: true,
      hasNewThreadTarget: true,
      threadStartProgressMode: "none",
      hideThinkingWhenDone: true,
      showApprovals: false,
      showUserInput: false,
      collaborationMode: "default",
      hasCollaborationModes: true,
      permissionMode: "sandbox",
      connectionStatus: "connected",
      accountMode: "chatgpt",
    },
  },
  {
    id: "new-thread-worktree-setup",
    name: "Worktree Setup (Running)",
    description: "Real-time new-worktree setup progress log in the New thread tab.",
    controls: {
      threadMode: "none",
      isNewThreadTab: true,
      hasNewThreadTarget: true,
      threadStartProgressMode: "runningSetup",
      hideThinkingWhenDone: true,
      showApprovals: false,
      showUserInput: false,
      collaborationMode: "default",
      hasCollaborationModes: true,
      permissionMode: "sandbox",
      connectionStatus: "connected",
      accountMode: "chatgpt",
    },
  },
  {
    id: "new-thread-worktree-failed",
    name: "Worktree Setup (Failed)",
    description: "Failed setup state with stderr-rich progress output in the New thread tab.",
    controls: {
      threadMode: "none",
      isNewThreadTab: true,
      hasNewThreadTarget: true,
      threadStartProgressMode: "failed",
      hideThinkingWhenDone: true,
      showApprovals: false,
      showUserInput: false,
      collaborationMode: "default",
      hasCollaborationModes: true,
      permissionMode: "sandbox",
      connectionStatus: "connected",
      accountMode: "chatgpt",
    },
  },
  {
    id: "auth-login",
    name: "Auth / Login",
    description: "No account logged in, with pending login state.",
    controls: {
      threadMode: "none",
      isNewThreadTab: false,
      hasNewThreadTarget: false,
      threadStartProgressMode: "none",
      hideThinkingWhenDone: true,
      showApprovals: false,
      showUserInput: false,
      collaborationMode: "default",
      hasCollaborationModes: false,
      permissionMode: "custom",
      connectionStatus: "starting",
      accountMode: "pendingLogin",
    },
  },
];

export const STAGE_THREADS_STORY_DEFAULT_PRESET = STAGE_THREADS_STORY_PRESETS[0];

export function resolveStageThreadsStoryPreset(id: string): StageThreadsStoryPreset {
  return STAGE_THREADS_STORY_PRESETS.find((preset) => preset.id === id) ?? STAGE_THREADS_STORY_DEFAULT_PRESET;
}

export const STORY_PROJECT_ID = "demo/project/threads";
export const STORY_CARD_ID = "card-thread-demo";
export const STORY_THREAD_ID = "thr_demo_1";
export const STORY_WORKSPACE_PATH = "/workspace/nodex";
export const STORY_WORKTREE_PATH = "/workspace/.codex/worktrees/8153/nodex2";

const STORY_DIFF_FILE_PATH =
  "/workspace/nodex/src/renderer/components/workbench/stage-threads/tools/file-change-tool-call.tsx";

export const STORY_DIFF_HUNK = [
  "@@ -5,2 +5,7 @@",
  " import type { CodexItemView } from \"../../../../lib/types\";",
  "+import {",
  "+  NODEX_DIFF_HOST_CLASS,",
  "+  getNodexDiffHostStyle,",
  "+  getNodexDiffOptions,",
  "+} from \"./diff-presentation\";",
  " import { InlineToolToggle, ToolErrorDetail } from \"./tool-primitives\";",
  "@@ -179,4 +184,5 @@",
  "   const label = buildLabel(filenames);",
  "-  // TODO custom theme",
  "-  const theme = resolved === \"dark\" ? \"pierre-dark\" : \"github-light\";",
  "+  const diffOptions = useMemo(() => getNodexDiffOptions(resolved, isSingleFile), [resolved, isSingleFile]);",
  "+  const diffHostStyle = useMemo(() => getNodexDiffHostStyle(), []);",
  "+  const diffHostClassName = `${NODEX_DIFF_HOST_CLASS} max-h-[250px] overflow-y-auto`;",
  " ",
  "@@ -195,10 +201,5 @@",
  "               patch={patch}",
  "-              options={{",
  "-                theme,",
  "-                themeType: resolved,",
  "-                diffStyle: \"unified\",",
  "-                diffIndicators: \"bars\",",
  "-                overflow: \"scroll\",",
  "-                disableFileHeader: isSingleFile,",
  "-              }}",
  "+              className={diffHostClassName}",
  "+              style={diffHostStyle}",
  "+              options={diffOptions}",
  "             />",
  "@@ -212,10 +213,5 @@",
  "               fileDiff={fileDiff}",
  "-              options={{",
  "-                theme,",
  "-                themeType: resolved,",
  "-                diffStyle: \"unified\",",
  "-                diffIndicators: \"bars\",",
  "-                overflow: \"scroll\",",
  "-                disableFileHeader: isSingleFile,",
  "-              }}",
  "+              className={diffHostClassName}",
  "+              style={diffHostStyle}",
  "+              options={diffOptions}",
  "             />",
].join("\n");

export const STORY_DIFF_PATCH = [
  `diff --git a/${STORY_DIFF_FILE_PATH} b/${STORY_DIFF_FILE_PATH}`,
  `--- a/${STORY_DIFF_FILE_PATH}`,
  `+++ b/${STORY_DIFF_FILE_PATH}`,
  STORY_DIFF_HUNK,
].join("\n");

type StoryThreadMode = Extract<StageThreadsStoryThreadMode, "idle" | "running">;

function makeTokenUsage(usedTokens: number, modelContextWindow: number): NonNullable<CodexTurnSummary["tokenUsage"]> {
  return {
    total: {
      totalTokens: usedTokens,
      inputTokens: Math.max(0, usedTokens - 12_000),
      cachedInputTokens: 12_000,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    last: {
      totalTokens: usedTokens,
      inputTokens: Math.max(0, usedTokens - 12_000),
      cachedInputTokens: 12_000,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    modelContextWindow,
  };
}

function makeTurnSummary(
  threadId: string,
  turnId: string,
  status: CodexTurnSummary["status"],
  itemIds: string[],
  tokenUsage?: CodexTurnSummary["tokenUsage"],
): CodexTurnSummary {
  return {
    threadId,
    turnId,
    status,
    itemIds,
    tokenUsage,
  };
}

export function buildMockThread(mode: StoryThreadMode): CodexThreadDetail {
  const now = Date.now();
  const createdAtBase = now - 10 * 60 * 1000;
  let index = 0;

  const makeItem = (
    partial: Omit<CodexItemView, "threadId" | "itemId" | "createdAt" | "updatedAt">,
  ): CodexItemView => {
    index += 1;
    return {
      threadId: STORY_THREAD_ID,
      itemId: `item_${index}`,
      createdAt: createdAtBase + index * 1000,
      updatedAt: createdAtBase + index * 1000,
      ...partial,
    };
  };

  const turn1 = "turn_demo_1";
  const turn2 = "turn_demo_2";
  const turn3 = "turn_demo_3";

  const items: CodexItemView[] = [
    makeItem({
      turnId: turn1,
      type: "userMessage",
      normalizedKind: "userMessage",
      role: "user",
      markdownText: "Please inspect the current thread UI and summarize improvements.",
    }),
    makeItem({
      turnId: turn1,
      type: "reasoning",
      normalizedKind: "reasoning",
      markdownText: "Checking transcript renderer, tool-card registry, and command metadata mapping.",
    }),
    makeItem({
      turnId: turn1,
      type: "plan",
      normalizedKind: "plan",
      role: "assistant",
      markdownText: [
        "Title: Calculate 1+1",
        "",
        "Summary",
        "",
        "- Use the built-in `calculator` tool to evaluate the literal expression `1+1` and record the numeric output.",
        "",
        "Implementation Changes",
        "",
        "- Invoke the `calculator` tool with the expression `1+1` to get the result without editing any files.",
        "",
        "Test Plan",
        "",
        "- Verify the calculator response returns `2`, which confirms the addition was computed correctly.",
        "",
        "Assumptions",
        "",
        "- No repository edits or further tooling are required; this is purely a computation task.",
      ].join("\n"),
    }),
    makeItem({
      turnId: turn1,
      type: "commandExecution",
      normalizedKind: "commandExecution",
      status: "completed",
      toolCall: {
        subtype: "command",
        toolName: "bash",
        args: {
          command: "bash -lc \"cat src/renderer/app.tsx && rg stage-threads src/renderer\"",
          cwd: STORY_WORKSPACE_PATH,
          commandActions: [
            { type: "read", command: "cat src/renderer/app.tsx", name: "app.tsx", path: "src/renderer/app.tsx" },
            { type: "search", command: "rg stage-threads src/renderer", query: "stage-threads", path: "src/renderer" },
          ],
        },
        result: "Matches found in 4 files.",
      },
    }),
    makeItem({
      turnId: turn1,
      type: "commandExecution",
      normalizedKind: "commandExecution",
      status: "failed",
      toolCall: {
        subtype: "command",
        toolName: "bash",
        args: {
          command: "bun run lint",
          cwd: STORY_WORKSPACE_PATH,
        },
        result: "src/main/codex/codex-item-normalizer.ts:123:1 error",
        error: "Lint failed with exit code 1",
      },
    }),
    makeItem({
      turnId: turn1,
      type: "fileChange",
      normalizedKind: "fileChange",
      status: "completed",
      toolCall: {
        subtype: "fileChange",
        toolName: "file_change",
        args: {
          label: "Edited file-change-tool-call.tsx",
          changes: [
            {
              path: STORY_DIFF_FILE_PATH,
              diff: STORY_DIFF_HUNK,
            },
          ],
        },
        result: {
          paths: [STORY_DIFF_FILE_PATH],
          diff: STORY_DIFF_PATCH,
        },
      },
    }),
    makeItem({
      turnId: turn1,
      type: "mcpToolCall",
      normalizedKind: "toolCall",
      status: "completed",
      toolCall: {
        subtype: "mcp",
        toolName: "query-docs",
        server: "context7",
        args: { libraryId: "/vercel/next.js", query: "dev-only route" },
        result: { snippets: 6 },
      },
    }),
    makeItem({
      turnId: turn1,
      type: "webSearch",
      normalizedKind: "toolCall",
      status: "completed",
      toolCall: {
        subtype: "webSearch",
        toolName: "web_search",
        args: { query: "Vite import.meta.env.DEV" },
        result: { hits: 3 },
      },
    }),
    makeItem({
      turnId: turn1,
      type: "futureToolThing",
      normalizedKind: "toolCall",
      status: "failed",
      toolCall: {
        subtype: "generic",
        toolName: "future_tool",
        args: { mode: "dry-run" },
        result: { ok: false },
        error: "Tool registry mismatch",
      },
      rawItem: {
        type: "futureToolThing",
        mode: "dry-run",
        ok: false,
      },
    }),
    makeItem({
      turnId: turn2,
      type: "agentMessage",
      normalizedKind: "assistantMessage",
      role: "assistant",
      markdownText: "Implemented a dev-only story page for the thread panel and added scenario presets.",
    }),
  ];

  const turnSummaries = [
    makeTurnSummary(
      STORY_THREAD_ID,
      turn1,
      "completed",
      items.filter((item) => item.turnId === turn1).map((item) => item.itemId),
    ),
    makeTurnSummary(
      STORY_THREAD_ID,
      turn2,
      "completed",
      items.filter((item) => item.turnId === turn2).map((item) => item.itemId),
      makeTokenUsage(209_000, 258_000),
    ),
  ];

  if (mode === "running") {
    const inProgressReasoning = makeItem({
      turnId: turn3,
      type: "reasoning",
      normalizedKind: "reasoning",
      role: "assistant",
      status: "inProgress",
      markdownText: "Thinking through the current thread panel shape and composing a live update...",
    });
    const inProgressToolCall = makeItem({
      turnId: turn3,
      type: "webSearch",
      normalizedKind: "toolCall",
      status: "inProgress",
      toolCall: {
        subtype: "webSearch",
        toolName: "web_search",
        args: { query: "react streaming ui pending states" },
      },
    });
    const streamingItem = makeItem({
      turnId: turn3,
      type: "agentMessage",
      normalizedKind: "assistantMessage",
      role: "assistant",
      status: "inProgress",
      markdownText: "Still applying updates to the story panel...",
    });
    items.push(inProgressReasoning, inProgressToolCall, streamingItem);
    turnSummaries.push(
      makeTurnSummary(STORY_THREAD_ID, turn3, "inProgress", [
        inProgressReasoning.itemId,
        inProgressToolCall.itemId,
        streamingItem.itemId,
      ], makeTokenUsage(214_000, 258_000)),
    );
  }

  return {
    threadId: STORY_THREAD_ID,
    projectId: STORY_PROJECT_ID,
    cardId: STORY_CARD_ID,
    threadName: "Thread Panel Story",
    threadPreview: "Mock transcript with all item variants",
    modelProvider: "GPT-5.3-Codex",
    cwd: STORY_WORKSPACE_PATH,
    statusType: mode === "running" ? "active" : "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: now - 24 * 60 * 1000,
    updatedAt: now,
    linkedAt: new Date(now - 24 * 60 * 1000).toISOString(),
    turns: turnSummaries,
    items,
  };
}

export function buildMockStandaloneDiffItem(): CodexItemView {
  return {
    threadId: STORY_THREAD_ID,
    turnId: "turn_demo_preview",
    itemId: "item_preview_diff",
    type: "fileChange",
    normalizedKind: "fileChange",
    status: "completed",
    createdAt: Date.now() - 2_000,
    updatedAt: Date.now() - 2_000,
    toolCall: {
      subtype: "fileChange",
      toolName: "file_change",
      args: {
        label: "Edited file-change-tool-call.tsx",
        changes: [
          {
            path: STORY_DIFF_FILE_PATH,
            diff: STORY_DIFF_HUNK,
          },
        ],
      },
      result: {
        paths: [STORY_DIFF_FILE_PATH],
        diff: STORY_DIFF_PATCH,
      },
    },
  };
}
