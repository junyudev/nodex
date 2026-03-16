import { useCallback, useEffect, useMemo, useState } from "react";
import { StageThreads } from "./stage-threads";
import {
  buildMockStandaloneDiffItem,
  buildMockThread,
  type StageThreadsStoryAccountMode,
  type StageThreadsStoryControls,
  type StageThreadsStoryThreadStartProgressMode,
  STORY_CARD_ID,
  STORY_PROJECT_ID,
  STORY_THREAD_ID,
  STORY_WORKSPACE_PATH,
  STORY_WORKTREE_PATH,
} from "./stage-threads-dev-story-data";
import { FileChangeToolCall } from "./tools/file-change-tool-call";
import type {
  CodexAccountSnapshot,
  CodexApprovalRequest,
  CodexConnectionState,
  CodexItemView,
  CodexModelOption,
  CodexThreadStartProgressPhase,
  CodexUserInputRequest,
} from "@/lib/types";

export function StageThreadsInlineDiffPreviewCard({
  item,
}: {
  item: CodexItemView;
}) {
  return (
    <section className="shrink-0 rounded-lg border border-(--border) bg-(--background) shadow-card-sm">
      <div className="border-b border-(--border) px-3 py-2">
        <div className="text-xs font-semibold tracking-wide text-(--foreground-tertiary) uppercase">
          Inline Diff Preview
        </div>
        <div className="mt-1 text-xs/normal text-(--foreground-secondary)">
          Always-visible mock data for iterating on the thread-stage file diff styling.
        </div>
      </div>
      <div className="scrollbar-token h-56 overflow-y-auto px-3 py-3">
        <FileChangeToolCall item={item} defaultExpanded />
      </div>
    </section>
  );
}

const STORY_MODELS: CodexModelOption[] = [
  {
    id: "gpt-5.3-codex",
    model: "gpt-5.3-codex",
    displayName: "GPT-5.3-Codex",
    description: "Balanced coding model for most thread work.",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Use a lighter reasoning budget." },
      { reasoningEffort: "medium", description: "Balance speed and reasoning." },
      { reasoningEffort: "high", description: "Spend more time reasoning." },
      { reasoningEffort: "xhigh", description: "Use the maximum reasoning budget." },
    ],
    defaultReasoningEffort: "high",
    isDefault: true,
  },
  {
    id: "gpt-5-codex-mini",
    model: "gpt-5-codex-mini",
    displayName: "GPT-5-Codex Mini",
    description: "Faster, lower-cost option for small follow-ups.",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "minimal", description: "Use the lightest reasoning available." },
      { reasoningEffort: "low", description: "Use a lighter reasoning budget." },
      { reasoningEffort: "medium", description: "Balance speed and reasoning." },
    ],
    defaultReasoningEffort: "medium",
    isDefault: false,
  },
];

function buildMockAccount(mode: StageThreadsStoryAccountMode): CodexAccountSnapshot {
  if (mode === "loggedOut") {
    return {
      account: null,
      requiresOpenAiAuth: true,
      pendingLogin: null,
      rateLimits: null,
    };
  }

  if (mode === "pendingLogin") {
    return {
      account: null,
      requiresOpenAiAuth: true,
      pendingLogin: {
        loginId: "login_demo_1",
        authUrl: "https://chatgpt.com/codex-login/demo",
      },
      rateLimits: null,
    };
  }

  if (mode === "apiKey") {
    return {
      account: { type: "apiKey" },
      requiresOpenAiAuth: false,
      pendingLogin: null,
      rateLimits: {
        limitName: "Development",
        primary: { usedPercent: 52, windowDurationMins: 300 },
        secondary: { usedPercent: 33, windowDurationMins: 10080 },
      },
    };
  }

  return {
    account: { type: "chatgpt", email: "dev@example.com", planType: "Plus" },
    requiresOpenAiAuth: false,
    pendingLogin: null,
    rateLimits: {
      limitName: "ChatGPT Plus",
      primary: { usedPercent: 62, windowDurationMins: 300 },
      secondary: { usedPercent: 28, windowDurationMins: 10080 },
      credits: { hasCredits: true, unlimited: false, balance: "18.20" },
      planType: "Plus",
    },
  };
}

function buildConnection(status: CodexConnectionState["status"]): CodexConnectionState {
  return {
    status,
    retries: status === "error" ? 2 : 0,
    message: status === "error" ? "Transport handshake failed" : undefined,
    lastConnectedAt: status === "connected" ? Date.now() - 15000 : undefined,
  };
}

function buildApprovalQueue(threadId: string): CodexApprovalRequest[] {
  return [
    {
      requestId: "approval_demo_1",
      kind: "command",
      projectId: STORY_PROJECT_ID,
      cardId: STORY_CARD_ID,
      threadId,
      turnId: "turn_demo_3",
      itemId: "item_pending_cmd_1",
      reason: "Command needs elevated permissions",
      command: "git add . && git commit -m \"demo\"",
      cwd: STORY_WORKSPACE_PATH,
      createdAt: Date.now() - 8000,
    },
  ];
}

function buildUserInputQueue(threadId: string, multiQuestion?: boolean): CodexUserInputRequest[] {
  if (multiQuestion) {
    return [
      {
        requestId: "user_input_demo_multi",
        projectId: STORY_PROJECT_ID,
        cardId: STORY_CARD_ID,
        threadId,
        turnId: "turn_demo_3",
        itemId: "item_pending_input_multi",
        createdAt: Date.now() - 4000,
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "How much of the codebase should this change touch?",
            isOther: true,
            isSecret: false,
            options: [
              { label: "Minimal — single file", description: "Limit the change to one module." },
              { label: "Moderate — feature boundary", description: "Allow changes across the feature's files." },
              { label: "Broad — cross-cutting", description: "Refactor wherever needed." },
            ],
          },
          {
            id: "testing",
            header: "Testing Strategy",
            question: "Which testing approach do you prefer?",
            isOther: true,
            isSecret: false,
            options: [
              { label: "Unit tests only", description: "Fast, isolated coverage." },
              { label: "Integration tests", description: "Cover cross-module interactions." },
            ],
          },
          {
            id: "migration",
            header: "Migration",
            question: "Should the old API be kept for backwards compatibility?",
            isOther: false,
            isSecret: false,
            options: [
              { label: "Yes — deprecate gradually", description: "Keep the old path with a deprecation warning." },
              { label: "No — remove immediately", description: "Clean break, no legacy support." },
            ],
          },
        ],
      },
    ];
  }

  return [
    {
      requestId: "user_input_demo_1",
      projectId: STORY_PROJECT_ID,
      cardId: STORY_CARD_ID,
      threadId,
      turnId: "turn_demo_3",
      itemId: "item_pending_input_1",
      createdAt: Date.now() - 4000,
      questions: [
        {
          id: "delivery_style",
          header: "Delivery Style",
          question: "Which output style should the thread panel story prioritize?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Detailed", description: "Show every card type and edge state." },
            { label: "Compact", description: "Focus on daily UI iteration states only." },
          ],
        },
      ],
    },
  ];
}

function buildThreadStartProgressStory(
  mode: StageThreadsStoryThreadStartProgressMode,
): {
  phase: CodexThreadStartProgressPhase;
  message: string;
  outputText: string;
  updatedAt: number;
} | null {
  if (mode === "none") return null;

  const baseOutput = [
    "[info] Starting worktree creation",
    "Preparing worktree (detached HEAD 8b7a58a)",
    "HEAD is now at 8b7a58a fix card-stage run-in sync after thread start",
    `Worktree created at ${STORY_WORKTREE_PATH}`,
  ];

  if (mode === "creating") {
    return {
      phase: "creatingWorktree",
      message: "Creating a worktree and running setup.",
      outputText: `${baseOutput.join("\n")}\n`,
      updatedAt: Date.now(),
    };
  }

  if (mode === "runningSetup") {
    return {
      phase: "runningSetup",
      message: "Creating a worktree and running setup.",
      outputText: [
        ...baseOutput,
        "Running setup script .codex/environments/environment.toml",
        "+ bun install",
        "bun install v1.3.8 (b64edcb4)",
        "Resolving dependencies",
        "Resolved, downloaded and extracted [2]",
        "",
        "$ electron-builder install-app-deps",
        "• electron-builder  version=26.7.0",
        "• installing native dependencies arch=arm64",
        "• preparing moduleName=better-sqlite3 arch=arm64",
        "• finished moduleName=better-sqlite3 arch=arm64",
      ].join("\n"),
      updatedAt: Date.now(),
    };
  }

  return {
    phase: "failed",
    message: "Worktree setup failed.",
    outputText: [
      ...baseOutput,
      "Running setup script .codex/environments/environment.toml",
      "+ bun install",
      "[stderr] error: command failed with exit code 1",
      "[stderr] Failed to set up new worktree using environment '.codex/environments/environment.toml'",
    ].join("\n"),
    updatedAt: Date.now(),
  };
}

function buildSceneControls(props: StageThreadsDevStoryPageProps): StageThreadsStoryControls {
  return {
    threadMode: props.threadMode,
    isNewThreadTab: props.isNewThreadTab,
    hasNewThreadTarget: props.hasNewThreadTarget,
    threadStartProgressMode: props.threadStartProgressMode,
    hideThinkingWhenDone: props.hideThinkingWhenDone,
    showApprovals: props.showApprovals,
    showUserInput: props.showUserInput,
    collaborationMode: props.collaborationMode,
    hasCollaborationModes: props.hasCollaborationModes,
    permissionMode: props.permissionMode,
    connectionStatus: props.connectionStatus,
    accountMode: props.accountMode,
  };
}

export type StageThreadsDevStoryPageProps = StageThreadsStoryControls;

export function StageThreadsDevStoryPage(props: StageThreadsDevStoryPageProps) {
  const [controls, setControls] = useState<StageThreadsStoryControls>(() => buildSceneControls(props));
  const [approvalQueue, setApprovalQueue] = useState<CodexApprovalRequest[]>([]);
  const [userInputQueue, setUserInputQueue] = useState<CodexUserInputRequest[]>([]);

  useEffect(() => {
    setControls(buildSceneControls(props));
  }, [
    props.accountMode,
    props.collaborationMode,
    props.connectionStatus,
    props.hasCollaborationModes,
    props.hasNewThreadTarget,
    props.hideThinkingWhenDone,
    props.isNewThreadTab,
    props.permissionMode,
    props.showApprovals,
    props.showUserInput,
    props.threadMode,
    props.threadStartProgressMode,
  ]);

  const thread = useMemo(() => {
    if (controls.threadMode === "none") return null;
    return buildMockThread(controls.threadMode);
  }, [controls.threadMode]);
  const diffPreviewItem = useMemo(() => buildMockStandaloneDiffItem(), []);

  const threadForQueue = thread?.threadId ?? STORY_THREAD_ID;

  const isMultiQuestionPreset = controls.collaborationMode === "plan";

  useEffect(() => {
    setApprovalQueue(controls.showApprovals ? buildApprovalQueue(threadForQueue) : []);
    setUserInputQueue(controls.showUserInput ? buildUserInputQueue(threadForQueue, isMultiQuestionPreset) : []);
  }, [controls.showApprovals, controls.showUserInput, threadForQueue, isMultiQuestionPreset]);

  const newThreadTarget = useMemo(
    () =>
      controls.hasNewThreadTarget
        ? {
          projectId: STORY_PROJECT_ID,
          projectName: "Nodex",
          cardId: STORY_CARD_ID,
          cardTitle: "Improve Thread Panel UX",
          columnId: "6-in-progress",
        }
        : null,
    [controls.hasNewThreadTarget],
  );
  const threadStartProgress = useMemo(
    () => buildThreadStartProgressStory(controls.threadStartProgressMode),
    [controls.threadStartProgressMode],
  );

  const connection = useMemo(() => buildConnection(controls.connectionStatus), [controls.connectionStatus]);
  const account = useMemo(() => buildMockAccount(controls.accountMode), [controls.accountMode]);

  const updateControl = useCallback(
    <K extends keyof StageThreadsStoryControls>(key: K, value: StageThreadsStoryControls[K]) => {
      setControls((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  return (
    <div className="min-h-[calc(100vh-3rem)] bg-(--background) text-(--foreground)">
      <div className="mx-auto flex h-full min-h-0 max-w-245 flex-col gap-4">
        <section className="rounded-[24px] border border-(--border) bg-[color-mix(in_srgb,var(--background-secondary),transparent_10%)] px-5 py-4 shadow-[0_16px_40px_rgba(0,0,0,0.18)]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <div className="text-sm font-semibold">Threads Panel</div>
              <div className="mt-1 text-sm/relaxed text-(--foreground-secondary)">
                Production-backed thread-panel scene with transcript, approvals, and new-thread setup states. Presets are Storybook stories, and scene controls belong in Storybook Controls rather than a custom sidebar.
              </div>
            </div>
            <div className="flex max-w-md flex-wrap justify-end gap-2">
              <span className="rounded-full border border-(--border) bg-(--background) px-2.5 py-1 text-xs text-(--foreground-secondary)">
                {controls.threadMode}
              </span>
              <span className="rounded-full border border-(--border) bg-(--background) px-2.5 py-1 text-xs text-(--foreground-secondary)">
                {controls.connectionStatus}
              </span>
              <span className="rounded-full border border-(--border) bg-(--background) px-2.5 py-1 text-xs text-(--foreground-secondary)">
                {controls.accountMode}
              </span>
              <span className="rounded-full border border-(--border) bg-(--background) px-2.5 py-1 text-xs text-(--foreground-secondary)">
                {controls.permissionMode}
              </span>
            </div>
          </div>
        </section>

        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-(--border) bg-(--background) shadow-card-lg">
          <StageThreads
            projectId={STORY_PROJECT_ID}
            projectWorkspacePath={STORY_WORKSPACE_PATH}
            isNewThreadTab={controls.isNewThreadTab}
            newThreadTarget={newThreadTarget}
            activeThreadCardColumnId={thread ? "6-in-progress" : newThreadTarget?.columnId ?? null}
            threadStartProgress={threadStartProgress}
            thread={thread}
            connection={connection}
            account={account}
            availableModels={[...STORY_MODELS]}
            collaborationModes={controls.hasCollaborationModes
              ? [
                { name: "Default", mode: "default", model: null, reasoningEffort: undefined },
                { name: "Plan", mode: "plan", model: null, reasoningEffort: undefined },
              ]
              : []}
            selectedCollaborationMode={controls.collaborationMode}
            selectedModel="gpt-5.3-codex"
            selectedReasoningEffort="high"
            reasoningEffortOptions={[...STORY_MODELS[0].supportedReasoningEfforts]}
            permissionMode={controls.permissionMode}
            hideThinkingWhenDone={controls.hideThinkingWhenDone}
            promptSubmitShortcut="enter"
            approvalQueue={approvalQueue}
            userInputQueue={userInputQueue}
            planImplementationQueue={[]}
            onCollaborationModeChange={(mode) => {
              updateControl("collaborationMode", mode);
            }}
            onModelChange={() => {
            }}
            onReasoningEffortChange={() => {
            }}
            onPermissionModeChange={(mode) => {
              updateControl("permissionMode", mode);
            }}
            onRefreshAccount={async () => {
            }}
            onStartChatGptLogin={async () => {
              updateControl("accountMode", "pendingLogin");
              return {
                type: "chatgpt" as const,
                loginId: "login_demo_1",
                authUrl: "https://chatgpt.com/codex-login/demo",
              };
            }}
            onStartApiKeyLogin={async () => {
              updateControl("accountMode", "apiKey");
              return { type: "apiKey" as const };
            }}
            onCancelLogin={async () => {
              updateControl("accountMode", "loggedOut");
            }}
            onLogout={async () => {
              updateControl("accountMode", "loggedOut");
            }}
            onStartThreadForCard={async () => {
              updateControl("threadMode", "running");
              updateControl("isNewThreadTab", false);
            }}
            onSendPrompt={async () => {
            }}
            onSteerPrompt={async () => {
            }}
            onInterruptTurn={async () => {
              updateControl("threadMode", "idle");
            }}
            onRespondApproval={async (requestId: string) => {
              setApprovalQueue((prev) => prev.filter((entry) => entry.requestId !== requestId));
            }}
            onRespondUserInput={async (requestId) => {
              setUserInputQueue((prev) => prev.filter((entry) => entry.requestId !== requestId));
            }}
            onResolvePlanImplementationRequest={() => {
            }}
            onOpenCard={() => {
            }}
          />
        </div>

        <StageThreadsInlineDiffPreviewCard item={diffPreviewItem} />
      </div>
    </div>
  );
}
