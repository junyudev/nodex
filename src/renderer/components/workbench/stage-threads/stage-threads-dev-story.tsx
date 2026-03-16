import { useCallback, useEffect, useMemo, useState } from "react";
import { DevStoryFontSettingsSection } from "../../dev-story/dev-story-font-settings";
import { useDevStoryFontSize } from "../../../lib/use-dev-story-font-size";
import { StageThreads } from "./stage-threads";
import {
  buildMockStandaloneDiffItem,
  buildMockThread,
  STORY_CARD_ID,
  STORY_PROJECT_ID,
  STORY_THREAD_ID,
  STORY_WORKSPACE_PATH,
  STORY_WORKTREE_PATH,
} from "./stage-threads-dev-story-data";
import { FileChangeToolCall } from "./tools/file-change-tool-call";
import { cn } from "../../../lib/utils";
import type {
  CodexAccountSnapshot,
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexCollaborationModeKind,
  CodexConnectionState,
  CodexItemView,
  CodexModelOption,
  CodexPermissionMode,
  CodexThreadStartProgressPhase,
  CodexUserInputRequest,
} from "@/lib/types";

type ThreadMode = "none" | "idle" | "running";
type AccountMode = "loggedOut" | "pendingLogin" | "apiKey" | "chatgpt";
type ThreadStartProgressStoryMode = "none" | "creating" | "runningSetup" | "failed";

interface StoryControls {
  threadMode: ThreadMode;
  isNewThreadTab: boolean;
  hasNewThreadTarget: boolean;
  threadStartProgressMode: ThreadStartProgressStoryMode;
  hideThinkingWhenDone: boolean;
  showApprovals: boolean;
  showUserInput: boolean;
  collaborationMode: CodexCollaborationModeKind;
  hasCollaborationModes: boolean;
  permissionMode: CodexPermissionMode;
  connectionStatus: CodexConnectionState["status"];
  accountMode: AccountMode;
}

interface StoryPreset {
  id: string;
  name: string;
  description: string;
  controls: StoryControls;
}

const STORY_PRESETS: StoryPreset[] = [
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

const DEFAULT_PRESET = STORY_PRESETS[0];

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

function buildMockAccount(mode: AccountMode): CodexAccountSnapshot {
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

function presetById(id: string): StoryPreset {
  return STORY_PRESETS.find((preset) => preset.id === id) ?? DEFAULT_PRESET;
}

function buildThreadStartProgressStory(
  mode: ThreadStartProgressStoryMode,
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

export function StageThreadsDevStoryPage({ onExit }: { onExit: () => void }) {
  const [selectedPresetId, setSelectedPresetId] = useState(DEFAULT_PRESET.id);
  const [controls, setControls] = useState<StoryControls>(DEFAULT_PRESET.controls);
  const [actionLog, setActionLog] = useState<string[]>([]);
  const [approvalQueue, setApprovalQueue] = useState<CodexApprovalRequest[]>([]);
  const [userInputQueue, setUserInputQueue] = useState<CodexUserInputRequest[]>([]);
  const {
    sansFontSize,
    codeFontSize,
    setSansFontSize,
    setCodeFontSize,
    fontSizeVariables,
  } = useDevStoryFontSize();

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

  const pushLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setActionLog((prev) => [`${timestamp} - ${message}`, ...prev].slice(0, 10));
  }, []);

  const applyPreset = useCallback((presetId: string) => {
    const preset = presetById(presetId);
    setSelectedPresetId(preset.id);
    setControls(preset.controls);
    setActionLog([]);
  }, []);

  const updateControl = useCallback(
    <K extends keyof StoryControls>(key: K, value: StoryControls[K]) => {
      setControls((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  return (
    <div
      className="h-screen min-h-0 bg-(--background) text-(--foreground)"
      style={fontSizeVariables}
    >
      <div className="flex h-full min-h-0">
        <aside className="scrollbar-token w-85 shrink-0 overflow-y-auto border-r border-(--border) bg-(--background-secondary)">
          <div className="space-y-4 p-4">
            <div className="space-y-2">
              <div className="text-sm font-semibold">Threads Panel Story</div>
              <div className="text-sm/normal text-(--foreground-secondary)">
                Development-only mock page for iterating on the thread panel UI.
              </div>
              <div className="flex items-center gap-2">
                <code className="rounded-sm border border-(--border) bg-(--background) px-1.5 py-1 text-xs">
                  ?dev-story=threads-panel
                </code>
                <button
                  type="button"
                  className="h-7 rounded-sm border border-(--border) px-2.5 text-xs transition-colors hover:bg-(--background-tertiary)"
                  onClick={onExit}
                >
                  Back to app
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-semibold tracking-wide text-(--foreground-tertiary) uppercase">Presets</div>
              <div className="space-y-1.5">
                {STORY_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={cn(
                      "w-full rounded-md border px-2.5 py-2 text-left transition-colors",
                      selectedPresetId === preset.id
                        ? "border-(--foreground) bg-(--background)"
                        : "border-(--border) bg-(--background) hover:bg-(--background-tertiary)",
                    )}
                    onClick={() => applyPreset(preset.id)}
                  >
                    <div className="text-sm font-medium">{preset.name}</div>
                    <div className="mt-0.5 text-xs text-(--foreground-tertiary)">{preset.description}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2.5">
              <div className="text-xs font-semibold tracking-wide text-(--foreground-tertiary) uppercase">Controls</div>

              <label className="block text-xs text-(--foreground-secondary)">
                Thread mode
                <select
                  className="mt-1 h-8 w-full rounded-sm border border-(--border) bg-(--background) px-2 text-sm"
                  value={controls.threadMode}
                  onChange={(event) => updateControl("threadMode", event.target.value as ThreadMode)}
                >
                  <option value="none">none</option>
                  <option value="idle">idle</option>
                  <option value="running">running</option>
                </select>
              </label>

              <label className="block text-xs text-(--foreground-secondary)">
                Start progress
                <select
                  className="mt-1 h-8 w-full rounded-sm border border-(--border) bg-(--background) px-2 text-sm"
                  value={controls.threadStartProgressMode}
                  onChange={(event) => updateControl("threadStartProgressMode", event.target.value as ThreadStartProgressStoryMode)}
                >
                  <option value="none">none</option>
                  <option value="creating">creating</option>
                  <option value="runningSetup">running setup</option>
                  <option value="failed">failed</option>
                </select>
              </label>

              <label className="block text-xs text-(--foreground-secondary)">
                Connection
                <select
                  className="mt-1 h-8 w-full rounded-sm border border-(--border) bg-(--background) px-2 text-sm"
                  value={controls.connectionStatus}
                  onChange={(event) => updateControl("connectionStatus", event.target.value as CodexConnectionState["status"])}
                >
                  <option value="connected">connected</option>
                  <option value="starting">starting</option>
                  <option value="disconnected">disconnected</option>
                  <option value="missingBinary">missingBinary</option>
                  <option value="error">error</option>
                </select>
              </label>

              <label className="block text-xs text-(--foreground-secondary)">
                Account
                <select
                  className="mt-1 h-8 w-full rounded-sm border border-(--border) bg-(--background) px-2 text-sm"
                  value={controls.accountMode}
                  onChange={(event) => updateControl("accountMode", event.target.value as AccountMode)}
                >
                  <option value="loggedOut">loggedOut</option>
                  <option value="pendingLogin">pendingLogin</option>
                  <option value="apiKey">apiKey</option>
                  <option value="chatgpt">chatgpt</option>
                </select>
              </label>

              <label className="block text-xs text-(--foreground-secondary)">
                Collaboration mode
                <select
                  className="mt-1 h-8 w-full rounded-sm border border-(--border) bg-(--background) px-2 text-sm"
                  value={controls.collaborationMode}
                  onChange={(event) => updateControl("collaborationMode", event.target.value as CodexCollaborationModeKind)}
                >
                  <option value="default">default</option>
                  <option value="plan">plan</option>
                </select>
              </label>

              <label className="block text-xs text-(--foreground-secondary)">
                Permission mode
                <select
                  className="mt-1 h-8 w-full rounded-sm border border-(--border) bg-(--background) px-2 text-sm"
                  value={controls.permissionMode}
                  onChange={(event) => updateControl("permissionMode", event.target.value as CodexPermissionMode)}
                >
                  <option value="sandbox">sandbox</option>
                  <option value="full-access">full-access</option>
                  <option value="custom">custom</option>
                </select>
              </label>

              <label className="flex items-center gap-2 text-xs text-(--foreground-secondary)">
                <input
                  type="checkbox"
                  checked={controls.isNewThreadTab}
                  onChange={(event) => updateControl("isNewThreadTab", event.target.checked)}
                />
                New thread tab
              </label>
              <label className="flex items-center gap-2 text-xs text-(--foreground-secondary)">
                <input
                  type="checkbox"
                  checked={controls.hasNewThreadTarget}
                  onChange={(event) => updateControl("hasNewThreadTarget", event.target.checked)}
                />
                New thread target
              </label>
              <label className="flex items-center gap-2 text-xs text-(--foreground-secondary)">
                <input
                  type="checkbox"
                  checked={controls.hideThinkingWhenDone}
                  onChange={(event) => updateControl("hideThinkingWhenDone", event.target.checked)}
                />
                Hide thinking when done
              </label>
              <label className="flex items-center gap-2 text-xs text-(--foreground-secondary)">
                <input
                  type="checkbox"
                  checked={controls.showApprovals}
                  onChange={(event) => updateControl("showApprovals", event.target.checked)}
                />
                Show approval requests
              </label>
              <label className="flex items-center gap-2 text-xs text-(--foreground-secondary)">
                <input
                  type="checkbox"
                  checked={controls.showUserInput}
                  onChange={(event) => updateControl("showUserInput", event.target.checked)}
                />
                Show user-input requests
              </label>
              <label className="flex items-center gap-2 text-xs text-(--foreground-secondary)">
                <input
                  type="checkbox"
                  checked={controls.hasCollaborationModes}
                  onChange={(event) => updateControl("hasCollaborationModes", event.target.checked)}
                />
                Collaboration presets available
              </label>
            </div>

            <DevStoryFontSettingsSection
              sansFontSize={sansFontSize}
              codeFontSize={codeFontSize}
              setSansFontSize={setSansFontSize}
              setCodeFontSize={setCodeFontSize}
            />

            <div className="space-y-2">
              <div className="text-xs font-semibold tracking-wide text-(--foreground-tertiary) uppercase">Actions</div>
              <div className="scrollbar-token max-h-40 space-y-1 overflow-y-auto rounded-md border border-(--border) bg-(--background) p-2 text-xs text-(--foreground-secondary)">
                {actionLog.length === 0 ? <div>No actions yet.</div> : actionLog.map((entry) => <div key={entry}>{entry}</div>)}
              </div>
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-hidden p-4">
          <div className="mx-auto flex h-full min-h-0 max-w-245 flex-col gap-3">
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
                  pushLog(`collaboration mode -> ${mode}`);
                }}
                onModelChange={(model) => {
                  pushLog(`model -> ${model}`);
                }}
                onReasoningEffortChange={(reasoningEffort) => {
                  pushLog(`reasoning -> ${reasoningEffort}`);
                }}
                onPermissionModeChange={(mode) => {
                  updateControl("permissionMode", mode);
                  pushLog(`permission mode -> ${mode}`);
                }}
                onRefreshAccount={async () => {
                  pushLog("refresh account");
                }}
                onStartChatGptLogin={async () => {
                  pushLog("start ChatGPT login");
                  updateControl("accountMode", "pendingLogin");
                  return {
                    type: "chatgpt" as const,
                    loginId: "login_demo_1",
                    authUrl: "https://chatgpt.com/codex-login/demo",
                  };
                }}
                onStartApiKeyLogin={async (apiKey) => {
                  pushLog(`start API key login (${apiKey.length} chars)`);
                  updateControl("accountMode", "apiKey");
                  return { type: "apiKey" as const };
                }}
                onCancelLogin={async (loginId) => {
                  pushLog(`cancel login ${loginId}`);
                  updateControl("accountMode", "loggedOut");
                }}
                onLogout={async () => {
                  pushLog("logout");
                  updateControl("accountMode", "loggedOut");
                }}
                onStartThreadForCard={async ({ cardId, prompt }) => {
                  pushLog(`start thread (${controls.collaborationMode}) for card ${cardId}: ${prompt.slice(0, 48)}`);
                  updateControl("threadMode", "running");
                  updateControl("isNewThreadTab", false);
                }}
                onSendPrompt={async (prompt, opts) => {
                  pushLog(`send prompt (${opts?.collaborationMode ?? controls.collaborationMode}): ${prompt.slice(0, 48)}`);
                }}
                onSteerPrompt={async (turnId, prompt) => {
                  pushLog(`steer ${turnId}: ${prompt.slice(0, 48)}`);
                }}
                onInterruptTurn={async (turnId) => {
                  pushLog(`interrupt turn ${turnId ?? "(latest)"}`);
                  updateControl("threadMode", "idle");
                }}
                onRespondApproval={async (requestId: string, decision: CodexApprovalDecision) => {
                  pushLog(`approval ${requestId}: ${decision}`);
                  setApprovalQueue((prev) => prev.filter((entry) => entry.requestId !== requestId));
                }}
                onRespondUserInput={async (requestId, answers) => {
                  pushLog(`user input ${requestId}: ${JSON.stringify(answers)}`);
                  setUserInputQueue((prev) => prev.filter((entry) => entry.requestId !== requestId));
                }}
                onResolvePlanImplementationRequest={(threadId, turnId) => {
                  pushLog(`resolve plan implementation ${threadId}:${turnId}`);
                }}
                onOpenCard={(cardId) => {
                  pushLog(`open card ${cardId}`);
                }}
              />
            </div>

            <StageThreadsInlineDiffPreviewCard item={diffPreviewItem} />
          </div>
        </main>
      </div>
    </div>
  );
}
