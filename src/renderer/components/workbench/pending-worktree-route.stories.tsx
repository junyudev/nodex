import type { Meta, StoryObj } from "@storybook/react-vite";
import { MotionConfig } from "motion/react";
import type {
  CodexPendingWorktreeEntry,
  CodexPendingWorktreeThreadResolution,
} from "../../../shared/codex-pending-worktree";
import { PendingWorktreeRouteView } from "./pending-worktree-route";

const CLIENT_THREAD_ID = "client-new-thread:11111111-1111-4111-8111-111111111111";

type StartConversationEntry = Extract<
  CodexPendingWorktreeEntry,
  { readonly launchMode: "start-conversation" }
>;

function makeEntry(overrides: Partial<StartConversationEntry> = {}): StartConversationEntry {
  return {
    id: "local:pending-1",
    hostId: "local",
    label: "Prepare an isolated workspace for the task",
    sourceWorkspaceRoot: "/Users/asc/repo/nodex",
    startingState: { type: "branch", branchName: "main" },
    localEnvironmentConfigPath: null,
    prompt: "Create an isolated workspace, install dependencies, and implement the task.",
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
    createdAt: Date.now(),
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

function waiting(entry: CodexPendingWorktreeEntry): CodexPendingWorktreeThreadResolution {
  if (entry.launchMode === "create-stable-worktree") {
    throw new Error("A stable worktree has no client thread id");
  }
  return {
    state: "waiting",
    clientThreadId: entry.clientThreadId,
    pendingWorktreeId: entry.id,
  };
}

function starting(entry: StartConversationEntry): CodexPendingWorktreeThreadResolution {
  return {
    state: "starting",
    clientThreadId: entry.clientThreadId,
    pendingWorktreeId: entry.id,
  };
}

const meta = {
  title: "Workbench/Pending worktree route",
  component: PendingWorktreeRouteView,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Pending worktree thread body in the normal thread hierarchy: the original user prompt, phase-specific activity/output, and exact recovery actions before the real thread exists.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="h-screen bg-token-main-surface-primary">
        <Story />
      </div>
    ),
  ],
  args: {
    entry: makeEntry(),
    resolution: null,
    busyAction: null,
    actionError: null,
    onCancel: () => undefined,
    onContinue: () => undefined,
    onAutoFix: () => undefined,
    onEditEnvironment: () => undefined,
    onRetry: () => undefined,
    onWorkLocally: () => undefined,
  },
} satisfies Meta<typeof PendingWorktreeRouteView>;

export default meta;

type Story = StoryObj<typeof meta>;

const narrowViewport = {
  defaultViewport: "pending-worktree-narrow",
  options: {
    "pending-worktree-narrow": {
      name: "Pending worktree narrow (480×720)",
      styles: { width: "480px", height: "720px" },
    },
  },
};

const wideViewport = {
  defaultViewport: "pending-worktree-wide",
  options: {
    "pending-worktree-wide": {
      name: "Pending worktree wide (1440×900)",
      styles: { width: "1440px", height: "900px" },
    },
  },
};

const queuedEntry = makeEntry({ phase: "queued" });

export const Queued: Story = {
  args: {
    entry: queuedEntry,
    resolution: waiting(queuedEntry),
  },
};

const creatingEntry = makeEntry({
  phase: "creating",
  worktreeOutputText:
    "[info] Starting worktree creation\nPreparing worktree (detached HEAD 7e3ad91)\n",
});

export const Creating: Story = {
  args: {
    entry: creatingEntry,
    resolution: waiting(creatingEntry),
  },
};

const checkoutProgressEntry = makeEntry({
  phase: "creating",
  worktreeOutputText:
    "[info] Starting worktree creation\nPreparing worktree (detached HEAD 7e3ad91)\nUpdating files: 43% (43/100)\n",
});

export const CheckingOutFiles: Story = {
  args: {
    entry: checkoutProgressEntry,
    resolution: waiting(checkoutProgressEntry),
  },
};

export const CheckingOutFilesExpanded: Story = {
  args: CheckingOutFiles.args,
  play: async ({ canvasElement }) => {
    const detailsButton = Array.from(canvasElement.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "More details",
    );
    detailsButton?.click();
  },
};

export const CreatingNarrow: Story = {
  ...Creating,
  parameters: { viewport: narrowViewport },
};

const setupEntry = makeEntry({
  phase: "setting-up",
  worktreeGitRoot: "/Users/asc/.codex/worktrees/7e3a/nodex",
  worktreeWorkspaceRoot: "/Users/asc/.codex/worktrees/7e3a/nodex",
  localEnvironmentConfigPath: "/Users/asc/repo/nodex/.codex/environments/default.toml",
  worktreeOutputText:
    "[info] Starting worktree creation\nPreparing worktree (detached HEAD 7e3ad91)\nHEAD is now at 7e3ad91\n",
  setupOutputText:
    "bun install v1.2.18\n\u001b[32mResolved, downloaded and extracted packages\u001b[0m\n",
});

export const SettingUpEnvironment: Story = {
  args: {
    entry: setupEntry,
    resolution: waiting(setupEntry),
  },
};

export const SettingUpEnvironmentWide: Story = {
  ...SettingUpEnvironment,
  parameters: { viewport: wideViewport },
};

export const SettingUpEnvironmentReducedMotion: Story = {
  args: SettingUpEnvironment.args,
  render: (args) => (
    <MotionConfig reducedMotion="always">
      <PendingWorktreeRouteView {...args} />
    </MotionConfig>
  ),
};

export const CancelingSetup: Story = {
  args: {
    entry: setupEntry,
    resolution: waiting(setupEntry),
    busyAction: "cancel",
  },
};

const readyEntry = makeEntry({
  phase: "worktree-ready",
  worktreeGitRoot: "/Users/asc/.codex/worktrees/7e3a/nodex",
  worktreeWorkspaceRoot: "/Users/asc/.codex/worktrees/7e3a/nodex",
  localEnvironmentConfigPath: "/Users/asc/repo/nodex/.codex/environments/default.toml",
  worktreeOutputText: "[info] Worktree created\n",
  setupOutputText: "Environment ready\n",
});

export const StartingConversation: Story = {
  args: {
    entry: readyEntry,
    resolution: starting(readyEntry),
  },
};

const readyWithoutEnvironmentEntry = makeEntry({
  phase: "worktree-ready",
  worktreeGitRoot: "/Users/asc/.codex/worktrees/7e3a/nodex",
  worktreeWorkspaceRoot: "/Users/asc/.codex/worktrees/7e3a/nodex",
  worktreeOutputText: "[info] Worktree created\n",
});

export const StartingConversationWithoutEnvironment: Story = {
  args: {
    entry: readyWithoutEnvironmentEntry,
    resolution: starting(readyWithoutEnvironmentEntry),
  },
};

const skippedSetupEntry = makeEntry({
  phase: "worktree-ready",
  worktreeGitRoot: "/Users/asc/.codex/worktrees/7e3a/nodex",
  worktreeWorkspaceRoot: "/Users/asc/.codex/worktrees/7e3a/nodex",
  localEnvironmentConfigPath: "/Users/asc/repo/nodex/.codex/environments/default.toml",
  worktreeOutputText: "[info] Worktree created\n",
  setupOutputText: "error: postinstall script failed with exit code 1\n",
  errorMessage: "Local environment setup exited with status 1",
});

export const SetupSkipped: Story = {
  args: {
    entry: skippedSetupEntry,
    resolution: waiting(skippedSetupEntry),
  },
};

const failedEntry = makeEntry({
  phase: "failed",
  worktreeGitRoot: "/Users/asc/.codex/worktrees/7e3a/nodex",
  worktreeWorkspaceRoot: "/Users/asc/.codex/worktrees/7e3a/nodex",
  localEnvironmentConfigPath: "/Users/asc/repo/nodex/.codex/environments/default.toml",
  worktreeOutputText: "[info] Worktree created\n",
  setupOutputText:
    "bun install v1.2.18\n\u001b[31merror: postinstall script failed with exit code 1\u001b[0m\n",
  errorMessage: "Local environment setup exited with status 1",
  needsAttention: true,
});

export const SetupFailed: Story = {
  args: {
    entry: failedEntry,
    resolution: {
      state: "failed",
      clientThreadId: CLIENT_THREAD_ID,
      pendingWorktreeId: failedEntry.id,
      errorMessage: failedEntry.errorMessage,
    },
  },
};

export const SetupFailedDark: Story = {
  ...SetupFailed,
  globals: { theme: "dark" },
};

export const AutoFixingSetup: Story = {
  args: {
    ...SetupFailed.args,
    busyAction: "auto-fix",
  },
};

export const SetupFailureActionError: Story = {
  args: {
    ...SetupFailed.args,
    actionError: "The repair task could not be started.",
  },
};

const createFailedEntry = makeEntry({
  phase: "failed",
  worktreeOutputText:
    "[info] Starting worktree creation\nfatal: invalid reference: feature/missing\n",
  errorMessage: "Worktree creation failed",
  needsAttention: true,
});

export const WorktreeCreationFailed: Story = {
  args: {
    entry: createFailedEntry,
    resolution: {
      state: "failed",
      clientThreadId: CLIENT_THREAD_ID,
      pendingWorktreeId: createFailedEntry.id,
      errorMessage: createFailedEntry.errorMessage,
    },
  },
};

export const ConversationStartFailed: Story = {
  args: {
    entry: readyEntry,
    resolution: {
      state: "failed",
      clientThreadId: CLIENT_THREAD_ID,
      pendingWorktreeId: readyEntry.id,
      errorMessage: "The task could not be started.",
    },
  },
};
