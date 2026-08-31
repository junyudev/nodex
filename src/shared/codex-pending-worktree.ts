import type { CollaborationMode } from "@nodex/codex-app-server-protocol";
import type { UserInput } from "@nodex/codex-app-server-protocol/v2";
import type { Config } from "@nodex/codex-app-server-protocol/v2/Config";
import type { ThreadStartParams } from "@nodex/codex-app-server-protocol/v2/ThreadStartParams";
import type { CodexCanonicalWorktreeInitItem } from "./codex-conversation-state/codex-conversation-state";
import type {
  CodexAgentMode,
  CodexLiveFileAttachment,
  CodexReviewDiffCommentAttachment,
  CodexReasoningEffort,
  CodexThreadGoalFrozenDraft,
  CodexThreadStartHeartbeatAutomationInput,
  CodexThreadStartMemoryPreferences,
} from "./types";
import type { CodexExecutionProfile } from "./codex-execution-profile";
import type { BrowserUsePresentationOrigin } from "./browser-sidebar";

export type CodexPendingWorktreePhase =
  | "queued"
  | "creating"
  | "setting-up"
  | "worktree-ready"
  | "failed";

export type CodexPendingWorktreeStartingState =
  | {
      readonly type: "branch";
      readonly branchName: string;
      readonly remoteRef?: string;
    }
  | { readonly type: "working-tree" };

interface CodexPendingWorktreeRequestBase {
  readonly id: string;
  readonly hostId: string;
  readonly label: string;
  readonly initialThreadTitle?: string | null;
  readonly browserTransferSourceBrowserTabId?: string | null;
  readonly browserTransferSourceBrowserTabIds?: readonly string[] | null;
  readonly browserTransferSourceConversationId?: string | null;
  readonly browserTransferSourceViewScopeId?: string | null;
  readonly sourceWorkspaceRoot: string;
  readonly startingState?: CodexPendingWorktreeStartingState | null;
  /** Portable workspace-relative path under `.codex/environments`. */
  readonly localEnvironmentConfigPath?: string | null;
  readonly prompt: string;
}

export interface CodexPendingStableWorktreeRequest extends CodexPendingWorktreeRequestBase {
  readonly launchMode: "create-stable-worktree";
  readonly sourceWorkspaceRoots: readonly string[];
  readonly clientThreadId?: never;
  readonly startConversationParamsInput: null;
  readonly sourceConversationId: null;
  readonly sourceCollaborationMode: null;
}

export interface CodexPendingForkConversationRequest extends CodexPendingWorktreeRequestBase {
  readonly launchMode: "fork-conversation";
  readonly sourceWorkspaceRoots: readonly string[];
  readonly clientThreadId: string;
  readonly startConversationParamsInput: null;
  readonly projectAssignment?: CodexPendingLocalProjectAssignment | null;
  readonly sourceConversationId: string;
  readonly sourceCollaborationMode: CollaborationMode | null;
  readonly targetTurnId?: string | null;
  readonly threadSource?: CodexPendingThreadSource | null;
}

export interface CodexPendingStartConversationRequest extends CodexPendingWorktreeRequestBase {
  readonly launchMode: "start-conversation";
  readonly clientThreadId: string;
  readonly localEnvironmentConfigPath: string | null;
  readonly startConversationParamsInput: CodexPendingStartConversationParamsInput;
  readonly projectSessionId?: string | null;
  readonly threadStartHostId?: string | null;
  readonly threadGoalDraft?: CodexThreadGoalFrozenDraft | null;
  readonly heartbeatAutomation?: CodexThreadStartHeartbeatAutomationInput | null;
  readonly skipAutoTitleGeneration?: boolean;
  readonly browserUsePresentationOrigin?: BrowserUsePresentationOrigin;
  readonly sourceConversationId: null;
  readonly sourceCollaborationMode: null;
}

/** Exact dynamic `tt` payload retained until the worktree conversation launches. */
export interface CodexPendingStartConversationParamsInput {
  readonly input: readonly UserInput[];
  readonly commentAttachments: readonly CodexReviewDiffCommentAttachment[];
  readonly workspaceRoots: readonly string[];
  readonly cwd: string;
  readonly fileAttachments: readonly CodexLiveFileAttachment[];
  readonly addedFiles: readonly CodexLiveFileAttachment[];
  readonly agentMode: CodexAgentMode;
  readonly permissionProfileId?: string | undefined;
  readonly shouldSendPermissionOverrides: boolean;
  readonly model: null;
  readonly executionProfile?: CodexExecutionProfile | null;
  readonly serviceTier: string | null;
  readonly reasoningEffort: CodexReasoningEffort | null;
  readonly collaborationMode: CollaborationMode | null;
  readonly config: Readonly<Partial<Config>>;
  readonly configOverrides?: Readonly<NonNullable<ThreadStartParams["config"]>> | undefined;
  readonly memoryPreferences?: CodexThreadStartMemoryPreferences | null | undefined;
  readonly mode?: string;
  readonly threadStartKind?: string;
  readonly baseInstructions?: string | null;
  readonly additionalDeveloperInstructions?: string | null;
  readonly threadSource: CodexPendingThreadSource;
  readonly workspaceKind: "project";
  readonly projectAssignment?: CodexPendingLocalProjectAssignment | null;
  readonly serviceName?: string | undefined;
}

export type CodexPendingThreadSource = "user" | "subagent" | "system";

export interface CodexPendingLocalProjectAssignment {
  readonly projectKind: "local";
  readonly projectId: string;
  readonly path?: string;
  readonly pendingCoreUpdate: false;
}

export const CODEX_PENDING_WORKTREE_FALLBACK_LABEL = "Codex Task";
export const CODEX_PENDING_WORKTREE_LABEL_MAX_LENGTH = 80;
export const CODEX_USER_REQUEST_SECTION_MARKER = "## My request for Codex:";
export const CODEX_PENDING_WORKTREE_SETUP_REPAIR_LABEL = "Fix worktree setup";

/** Exact prompt utility `JH`: use only the final explicit user-request section. */
export function extractCodexUserRequestSection(value: string): string {
  const sections = value.split(CODEX_USER_REQUEST_SECTION_MARKER);
  return sections.length <= 1 ? value : (sections.at(-1) ?? "").trim();
}

/** Exact pending-row prompt summary from bundle `q`: collapsed text, 80 chars, ellipsis. */
export function summarizeCodexPendingWorktreeLabel(prompt: string): string {
  const normalized = extractCodexUserRequestSection(prompt).trim().replace(/\s+/g, " ").trim();
  if (!normalized) return CODEX_PENDING_WORKTREE_FALLBACK_LABEL;
  if (normalized.length <= CODEX_PENDING_WORKTREE_LABEL_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, CODEX_PENDING_WORKTREE_LABEL_MAX_LENGTH - 1).trimEnd()}…`;
}

export type CodexPendingWorktreeRequest =
  | CodexPendingStableWorktreeRequest
  | CodexPendingForkConversationRequest
  | CodexPendingStartConversationRequest;

/** Frozen request before main allocates host-scoped pending and client identities. */
export type CodexPendingWorktreeCreateInput =
  | Omit<CodexPendingStableWorktreeRequest, "id">
  | Omit<CodexPendingForkConversationRequest, "id" | "clientThreadId">
  | Omit<CodexPendingStartConversationRequest, "id" | "clientThreadId">;

export interface CodexPendingWorktreeCreateResult {
  readonly pendingWorktreeId: string;
  readonly clientThreadId: string | null;
}

export function canCreateCodexPendingWorktreeSetupRepair(
  entry: CodexPendingWorktreeEntry,
): boolean {
  return (
    entry.phase === "failed" &&
    entry.localEnvironmentConfigPath != null &&
    entry.worktreeGitRoot != null &&
    entry.worktreeWorkspaceRoot != null
  );
}

/** Exact setup Auto-fix prompt; the repair task must not continue the original request. */
export function buildCodexPendingWorktreeSetupRepairPrompt(
  entry: CodexPendingWorktreeEntry,
): string {
  return [
    "Fix this project's local environment setup.",
    "The original worktree setup failed before its thread could start. Do not continue the original user request. Start a one-off repair task in this new worktree without running the broken setup automatically. Paths in the failure output refer to the original source or failed worktree, so edit the corresponding files in this current repair worktree. Inspect the selected local environment config and related setup files, reproduce the failure manually if useful, make the smallest source-controlled fix, verify the setup succeeds, and leave the proposed fix here for user review before they retry the original task. If the fix should not be made automatically, explain exactly what the user should change.",
    `Selected local environment config: ${entry.localEnvironmentConfigPath ?? ""}\nOriginal setup error: ${entry.errorMessage ?? ""}`,
    `Original setup output:\n\`\`\`text\n${entry.setupOutputText}\n\`\`\``,
  ].join("\n\n");
}

export type CodexPendingWorktreeEntry = CodexPendingWorktreeRequest & {
  readonly createdAt: number;
  readonly attempt: number;
  readonly phase: CodexPendingWorktreePhase;
  readonly labelEdited: boolean;
  readonly worktreeOutputText: string;
  readonly setupOutputText: string;
  readonly errorMessage: string | null;
  readonly worktreeWorkspaceRoot: string | null;
  readonly worktreeGitRoot: string | null;
  readonly needsAttention: boolean;
  readonly isPinned: boolean;
  readonly pinnedBeforeThreadId: string | null;
};

export type CodexPendingWorktreeThreadResolution =
  | {
      readonly state: "waiting";
      readonly clientThreadId: string;
      readonly pendingWorktreeId: string;
    }
  | {
      readonly state: "starting";
      readonly clientThreadId: string;
      readonly pendingWorktreeId: string;
    }
  | {
      readonly state: "failed";
      readonly clientThreadId: string;
      readonly pendingWorktreeId: string;
      readonly errorMessage: string | null;
    }
  | {
      readonly state: "succeeded";
      readonly clientThreadId: string;
      readonly threadId: string;
    };

export type CodexPendingWorktreesChangedEvent = readonly CodexPendingWorktreeEntry[];

export interface CodexPendingWorktreeWarningEvent {
  readonly clientThreadId: string;
  readonly kind: "heartbeat-automation-create-failed";
  readonly message: string;
  readonly pendingWorktreeId: string;
  readonly threadId: string;
}

/** Exact pending `Va`: only a ready worktree can seed the first conversation turn. */
export function buildCodexPendingWorktreeInitItem(
  entry: CodexPendingWorktreeEntry,
): CodexCanonicalWorktreeInitItem | null {
  if (entry.phase !== "worktree-ready") return null;
  return {
    type: "worktreeInit",
    id: `${entry.id}:${entry.attempt}`,
    worktreeOutputText: entry.worktreeOutputText,
    setup:
      entry.localEnvironmentConfigPath == null
        ? null
        : {
            outcome: entry.errorMessage === null ? "completed" : "skipped",
            outputText: entry.setupOutputText,
          },
  };
}
