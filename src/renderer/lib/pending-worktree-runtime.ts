import type {
  CodexPendingWorktreeCreateInput,
  CodexPendingWorktreeCreateResult,
  CodexPendingWorktreeEntry,
  CodexPendingWorktreeThreadResolution,
  CodexPendingWorktreesChangedEvent,
} from "../../shared/codex-pending-worktree";
import type {
  CodexForkBrowserSidePanelSnapshot,
  CodexForkBrowserTransferConsumeInput,
} from "../../shared/codex-fork-browser-transfer";
import type { CodexAgentMode } from "../../shared/types";
import { subscribeCodexPendingWorktreesChanged } from "./api";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "./renderer-command";

const resolvePendingWorktreeThreadCommand = defineRendererCommand({
  key: "pending_worktree.resolve_thread",
  channel: "codex:pending-worktree:resolve-thread",
  authority: "main",
  owner: "PendingWorktreeRuntime",
  protocol: { kind: "returned_value" },
});

const autoFixPendingWorktreeCommand = defineRendererCommand({
  key: "pending_worktree.auto_fix",
  channel: "codex:pending-worktree:auto-fix",
  authority: "external",
  owner: "PendingWorktreeRuntime",
  protocol: { kind: "pending_operation" },
});

const retryPendingWorktreeCommand = defineRendererCommand({
  key: "pending_worktree.retry",
  channel: "codex:pending-worktree:retry",
  authority: "external",
  owner: "PendingWorktreeRuntime",
  protocol: { kind: "pending_operation" },
});

const workLocallyPendingWorktreeCommand = defineRendererCommand({
  key: "pending_worktree.work_locally",
  channel: "codex:pending-worktree:work-locally",
  authority: "external",
  owner: "PendingWorktreeRuntime",
  protocol: { kind: "returned_value" },
});

const continuePendingWorktreeCommand = defineRendererCommand({
  key: "pending_worktree.continue",
  channel: "codex:pending-worktree:continue",
  authority: "external",
  owner: "PendingWorktreeRuntime",
  protocol: { kind: "pending_operation" },
});

const cancelPendingWorktreeCommand = defineRendererCommand({
  key: "pending_worktree.cancel",
  channel: "codex:pending-worktree:cancel",
  authority: "external",
  owner: "PendingWorktreeRuntime",
  protocol: { kind: "pending_operation" },
});

const renamePendingWorktreeCommand = defineRendererCommand({
  key: "pending_worktree.rename",
  channel: "codex:pending-worktree:rename",
  authority: "main",
  owner: "PendingWorktreeRuntime",
  protocol: { kind: "pending_operation" },
});

const setPendingWorktreePinnedCommand = defineRendererCommand({
  key: "pending_worktree.set_pinned",
  channel: "codex:pending-worktree:set-pinned",
  authority: "main",
  owner: "PendingWorktreeRuntime",
  protocol: { kind: "pending_operation" },
});

const clearPendingWorktreeAttentionCommand = defineRendererCommand({
  key: "pending_worktree.clear_attention",
  channel: "codex:pending-worktree:clear-attention",
  authority: "main",
  owner: "PendingWorktreeRuntime",
  protocol: { kind: "pending_operation" },
});

const createPendingWorktreeCommand = defineRendererCommand({
  key: "pending_worktree.create",
  channel: "codex:pending-worktree:create",
  authority: "external",
  owner: "PendingWorktreeRuntime",
  protocol: { kind: "pending_operation" },
});

const setPendingWorktreePinnedBeforeThreadCommand = defineRendererCommand({
  key: "pending_worktree.set_pinned_before_thread",
  channel: "codex:pending-worktree:set-pinned-before-thread",
  authority: "main",
  owner: "PendingWorktreeRuntime",
  protocol: { kind: "pending_operation" },
});

export function listPendingWorktrees(): Promise<CodexPendingWorktreeEntry[]> {
  return invokeRendererQuery("codex:pending-worktrees:list");
}

export function createPendingWorktree(
  input: CodexPendingWorktreeCreateInput,
): Promise<CodexPendingWorktreeCreateResult> {
  return invokePlainCommand(createPendingWorktreeCommand, input);
}

export function cancelPendingWorktree(hostId: string, pendingWorktreeId: string): Promise<void> {
  return invokePlainCommand(cancelPendingWorktreeCommand, hostId, pendingWorktreeId);
}

export function renamePendingWorktree(
  hostId: string,
  pendingWorktreeId: string,
  label: string,
): Promise<void> {
  return invokePlainCommand(renamePendingWorktreeCommand, hostId, pendingWorktreeId, label);
}

export function setPendingWorktreePinned(
  hostId: string,
  pendingWorktreeId: string,
  isPinned: boolean,
): Promise<void> {
  return invokePlainCommand(setPendingWorktreePinnedCommand, hostId, pendingWorktreeId, isPinned);
}

export function setPendingWorktreePinnedBeforeThread(
  hostId: string,
  pendingWorktreeId: string,
  beforeThreadId: string | null,
): Promise<void> {
  return invokePlainCommand(
    setPendingWorktreePinnedBeforeThreadCommand,
    hostId,
    pendingWorktreeId,
    beforeThreadId,
  );
}

export function clearPendingWorktreeAttention(
  hostId: string,
  pendingWorktreeId: string,
): Promise<void> {
  return invokePlainCommand(clearPendingWorktreeAttentionCommand, hostId, pendingWorktreeId);
}

export function consumeForkSidePanelTransfer(
  input: CodexForkBrowserTransferConsumeInput,
): Promise<CodexForkBrowserSidePanelSnapshot | null> {
  return invokeRendererControl("codex:fork-side-panel-transfer:consume", input);
}

export interface PendingWorktreeRouteTransport {
  list: () => Promise<readonly CodexPendingWorktreeEntry[]>;
  resolveThread: (clientThreadId: string) => Promise<CodexPendingWorktreeThreadResolution | null>;
  autoFix: (
    hostId: string,
    pendingWorktreeId: string,
    agentMode: CodexAgentMode,
  ) => Promise<CodexPendingWorktreeCreateResult>;
  retry: (hostId: string, pendingWorktreeId: string) => Promise<void>;
  workLocally: (
    hostId: string,
    pendingWorktreeId: string,
  ) => Promise<{ readonly threadId: string }>;
  continue: (hostId: string, pendingWorktreeId: string) => Promise<void>;
  cancel: (hostId: string, pendingWorktreeId: string) => Promise<void>;
  discardForkSidePanelTransfer: (pendingWorktreeId: string) => Promise<void>;
  rename: (hostId: string, pendingWorktreeId: string, label: string) => Promise<void>;
  setPinned: (hostId: string, pendingWorktreeId: string, isPinned: boolean) => Promise<void>;
  clearAttention: (hostId: string, pendingWorktreeId: string) => Promise<void>;
  subscribe: (listener: (entries: CodexPendingWorktreesChangedEvent) => void) => () => void;
}

export const pendingWorktreeRouteTransport: PendingWorktreeRouteTransport = {
  list: listPendingWorktrees,
  resolveThread: async (clientThreadId) =>
    await invokePlainCommand(resolvePendingWorktreeThreadCommand, clientThreadId),
  autoFix: async (hostId, pendingWorktreeId, agentMode) =>
    await invokePlainCommand(autoFixPendingWorktreeCommand, hostId, pendingWorktreeId, agentMode),
  retry: async (hostId, pendingWorktreeId) =>
    await invokePlainCommand(retryPendingWorktreeCommand, hostId, pendingWorktreeId),
  workLocally: async (hostId, pendingWorktreeId) =>
    await invokePlainCommand(workLocallyPendingWorktreeCommand, hostId, pendingWorktreeId),
  continue: async (hostId, pendingWorktreeId) =>
    await invokePlainCommand(continuePendingWorktreeCommand, hostId, pendingWorktreeId),
  cancel: cancelPendingWorktree,
  discardForkSidePanelTransfer: async (pendingWorktreeId) =>
    await invokeRendererControl(
      "codex:pending-worktree:discard-fork-side-panel-transfer",
      pendingWorktreeId,
    ),
  rename: renamePendingWorktree,
  setPinned: setPendingWorktreePinned,
  clearAttention: clearPendingWorktreeAttention,
  subscribe: subscribeCodexPendingWorktreesChanged,
};
