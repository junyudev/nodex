import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { WorktreeInitActivityList } from "@/features/local-conversation/view/shared/tools/worktree-init-activity-list";
import type { CodexWorktreeInitActivity } from "@/lib/codex-worktree-init-activity";
import type {
  CodexPendingWorktreeCreateResult,
  CodexPendingWorktreeEntry,
} from "../../../shared/codex-pending-worktree";

import type { StableWorktreeEntry } from "./stable-worktree-production";

export type { StableWorktreeEntry } from "./stable-worktree-production";

export interface StableWorktreeStatusDialogTransport {
  list: () => Promise<readonly CodexPendingWorktreeEntry[]>;
  subscribe: (listener: (entries: readonly CodexPendingWorktreeEntry[]) => void) => () => void;
  clearAttention: (hostId: string, pendingWorktreeId: string) => Promise<void>;
  cancel: (hostId: string, pendingWorktreeId: string) => Promise<void>;
  autoFix: (hostId: string, pendingWorktreeId: string) => Promise<CodexPendingWorktreeCreateResult>;
  retry: (hostId: string, pendingWorktreeId: string) => Promise<void>;
}

export interface StableWorktreeStatusDialogProps {
  pendingWorktreeId: string;

  transport: StableWorktreeStatusDialogTransport;
  onClose: () => void;
  onEditEnvironment: (entry: StableWorktreeEntry) => void;
  onOpenPendingWorktree: (clientThreadId: string) => void;
  onActionError?: (error: unknown) => void;
}

export interface StableWorktreeStatusDialogViewProps {
  entry: StableWorktreeEntry;
  autoFixing?: boolean;
  onClose: () => void;
  onCancel: () => void;
  onEditEnvironment: () => void;
  onAutoFix: () => void;
  onRetry: () => void;
}

function isWorktreeBusy(entry: StableWorktreeEntry): boolean {
  return entry.phase === "queued" || entry.phase === "creating" || entry.phase === "setting-up";
}

function canAutoFix(entry: StableWorktreeEntry): boolean {
  return (
    entry.phase === "failed" &&
    entry.localEnvironmentConfigPath != null &&
    entry.worktreeGitRoot != null &&
    entry.worktreeWorkspaceRoot != null
  );
}

function findStableWorktreeEntry(
  entries: readonly CodexPendingWorktreeEntry[],
  pendingWorktreeId: string,
): StableWorktreeEntry | null {
  const entry = entries.find((candidate) => candidate.id === pendingWorktreeId);
  if (!entry || entry.launchMode !== "create-stable-worktree") return null;
  return entry;
}

function resolveStableWorktreeActivities(
  entry: StableWorktreeEntry,
): readonly CodexWorktreeInitActivity[] {
  const created = entry.worktreeGitRoot !== null && entry.worktreeWorkspaceRoot !== null;
  const worktreeStatus =
    entry.phase === "queued" || entry.phase === "creating"
      ? "running"
      : entry.phase === "failed" && !created
        ? "failed"
        : "completed";
  const activities: CodexWorktreeInitActivity[] = [
    {
      id: `${entry.id}:${entry.attempt}:worktree`,
      kind: "worktree",
      status: worktreeStatus,
      outputText: entry.worktreeOutputText,
    },
  ];

  if (
    entry.localEnvironmentConfigPath == null ||
    entry.phase === "queued" ||
    entry.phase === "creating"
  ) {
    return activities;
  }
  activities.push({
    id: `${entry.id}:${entry.attempt}:setup`,
    kind: "setup",
    status:
      entry.phase === "setting-up"
        ? "running"
        : entry.phase === "failed" && created
          ? "failed"
          : entry.errorMessage === null
            ? "completed"
            : "skipped",
    outputText: entry.setupOutputText,
  });
  return activities;
}

export function StableWorktreeStatusDialogView({
  entry,
  autoFixing = false,
  onClose,
  onCancel,
  onEditEnvironment,
  onAutoFix,
  onRetry,
}: StableWorktreeStatusDialogViewProps) {
  const activities = resolveStableWorktreeActivities(entry);
  const busy = isWorktreeBusy(entry);
  const failed = entry.phase === "failed";
  const actions = busy ? (
    <NodexDialogAction onClick={onCancel}>Cancel</NodexDialogAction>
  ) : failed ? (
    <>
      <NodexDialogAction onClick={onEditEnvironment}>Edit environment</NodexDialogAction>
      {canAutoFix(entry) ? (
        <NodexDialogAction aria-busy={autoFixing} disabled={autoFixing} onClick={onAutoFix}>
          {autoFixing ? <ActivitySpinnerIcon className="icon-xs" /> : null}
          Auto-fix
        </NodexDialogAction>
      ) : null}
      <NodexDialogAction tone="primary" onClick={onRetry}>
        Retry
      </NodexDialogAction>
    </>
  ) : null;

  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent size="wide">
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle className="truncate">{entry.label}</NodexDialogTitle>
            <NodexDialogDescription>Creating a persistent project worktree</NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogBody>
            <WorktreeInitActivityList activities={activities} actions={actions} />
          </NodexDialogBody>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}

function StableWorktreeStatusDialogController({
  pendingWorktreeId,

  transport,
  onClose,
  onEditEnvironment,
  onOpenPendingWorktree,
  onActionError,
}: StableWorktreeStatusDialogProps) {
  const [entry, setEntry] = useState<StableWorktreeEntry | null | undefined>(undefined);
  const [autoFixing, setAutoFixing] = useState(false);
  const observedEntryRef = useRef(false);
  const clearedAttentionIdsRef = useRef(new Set<string>());

  const reportEffectError = useEffectEvent((error: unknown) => {
    onActionError?.(error);
  });
  const closeAfterEntryDisappears = useEffectEvent(() => {
    onClose();
  });
  const clearAttention = useEffectEvent((observedEntry: StableWorktreeEntry) => {
    void transport.clearAttention(observedEntry.hostId, observedEntry.id).catch(reportEffectError);
  });

  useEffect(() => {
    setEntry(undefined);
    let disposed = false;
    let receivedSubscription = false;

    const applyEntries = (entries: readonly CodexPendingWorktreeEntry[]) => {
      if (disposed) return;
      setEntry(findStableWorktreeEntry(entries, pendingWorktreeId));
    };
    const unsubscribe = transport.subscribe((entries) => {
      receivedSubscription = true;
      applyEntries(entries);
    });

    void transport
      .list()
      .then((entries) => {
        if (receivedSubscription) return;
        applyEntries(entries);
      })
      .catch((error) => {
        if (!disposed) reportEffectError(error);
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [pendingWorktreeId, transport]);

  useEffect(() => {
    if (!entry || clearedAttentionIdsRef.current.has(entry.id)) return;
    clearedAttentionIdsRef.current.add(entry.id);
    clearAttention(entry);
  }, [entry]);

  useEffect(() => {
    if (entry != null) {
      observedEntryRef.current = true;
      return;
    }
    if (entry === undefined || !observedEntryRef.current) return;
    closeAfterEntryDisappears();
  }, [entry]);

  if (!entry) return null;

  const reportActionError = (error: unknown) => {
    onActionError?.(error);
  };
  const runDetached = (action: () => Promise<unknown>) => {
    try {
      void action().catch(reportActionError);
    } catch (error) {
      reportActionError(error);
    }
  };

  return (
    <StableWorktreeStatusDialogView
      entry={entry}
      autoFixing={autoFixing}
      onClose={onClose}
      onCancel={() => {
        runDetached(() => transport.cancel(entry.hostId, entry.id));
        onClose();
      }}
      onEditEnvironment={() => {
        onClose();
        onEditEnvironment(entry);
      }}
      onAutoFix={() => {
        if (autoFixing) return;
        setAutoFixing(true);
        void transport
          .autoFix(entry.hostId, entry.id)
          .then((result) => {
            if (!result.clientThreadId) {
              throw new Error("The worktree repair task has no client thread id.");
            }
            onClose();
            onOpenPendingWorktree(result.clientThreadId);
          })
          .catch((error) => {
            setAutoFixing(false);
            reportActionError(error);
          });
      }}
      onRetry={() => {
        runDetached(() => transport.retry(entry.hostId, entry.id));
      }}
    />
  );
}

export function StableWorktreeStatusDialog(props: StableWorktreeStatusDialogProps) {
  return <StableWorktreeStatusDialogController key={props.pendingWorktreeId} {...props} />;
}
