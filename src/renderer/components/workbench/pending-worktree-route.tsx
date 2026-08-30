import {
  type ComponentPropsWithoutRef,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import {
  ActivitySpinnerIcon,
  CloseIcon,
  PendingWorktreeLocalIcon,
  RetryIcon,
} from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import {
  EnsureLocalConversationThreadScrollController,
  LocalConversationThreadScrollLayout,
} from "@/features/local-conversation/view/local-conversation-thread-scroll-controller";
import {
  CopyMessageActionButton,
  ThreadMessageActionRow,
} from "@/features/local-conversation/view/shared/thread-message-actions";
import { UserMessageText } from "@/features/local-conversation/view/shared/user-message-collapse";
import { THREAD_VISUAL_TOKENS } from "@/features/local-conversation/view/blocks/local-conversation-visual-tokens";
import {
  pendingWorktreeRouteTransport,
  type PendingWorktreeRouteTransport,
} from "@/lib/pending-worktree-runtime";
import { cn } from "@/lib/utils";
import type {
  CodexPendingWorktreeEntry,
  CodexPendingWorktreeThreadResolution,
} from "../../../shared/codex-pending-worktree";
import type { CodexAgentMode } from "../../../shared/types";
import { PendingWorktreeProgress } from "./pending-worktree-progress";
import { resolvePendingWorktreeRouteActions } from "./pending-worktree-route-model";

export type { PendingWorktreeRouteTransport } from "@/lib/pending-worktree-runtime";

type PendingWorktreeRouteAction = "auto-fix" | "cancel" | "continue" | "retry" | "work-locally";

interface PendingWorktreeRouteSnapshot {
  status: "loading" | "ready" | "missing" | "error";
  entry: CodexPendingWorktreeEntry | null;
  resolution: CodexPendingWorktreeThreadResolution | null;
  errorMessage: string | null;
}

const INITIAL_SNAPSHOT: PendingWorktreeRouteSnapshot = {
  status: "loading",
  entry: null,
  resolution: null,
  errorMessage: null,
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Worktree setup could not be loaded.";
}

function findPendingWorktreeEntry(
  entries: readonly CodexPendingWorktreeEntry[],
  clientThreadId: string,
): CodexPendingWorktreeEntry | null {
  return (
    entries.find(
      (entry) =>
        entry.launchMode !== "create-stable-worktree" && entry.clientThreadId === clientThreadId,
    ) ?? null
  );
}

export interface PendingWorktreeRouteViewProps {
  entry: CodexPendingWorktreeEntry;
  resolution: CodexPendingWorktreeThreadResolution | null;
  busyAction?: PendingWorktreeRouteAction | null;
  actionError?: string | null;
  onCancel: () => void;
  onContinue: () => void;
  onAutoFix: () => void;
  onEditEnvironment: () => void;
  onRetry: () => void;
  onWorkLocally: () => void;
}

function PendingWorktreeActionButton({
  children,
  disabled = false,
  loading = false,
  tone = "ghost",
  className,
  ...props
}: ComponentPropsWithoutRef<"button"> & {
  loading?: boolean;
  tone?: "ghost" | "primary" | "secondary";
}) {
  return (
    <button
      type="button"
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(
        "no-drag flex h-6 cursor-interaction items-center gap-1 rounded-full border border-transparent px-2 py-0.5 text-sm leading-[18px] whitespace-nowrap select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-token-focus disabled:cursor-not-allowed disabled:opacity-40",
        tone === "secondary" &&
          "bg-token-foreground/5 text-token-foreground enabled:hover:bg-token-foreground/10",
        tone === "ghost" && "text-token-text-tertiary enabled:hover:bg-token-list-hover-background",
        tone === "primary" &&
          "bg-token-foreground text-token-dropdown-background enabled:hover:bg-token-foreground/80",
        className,
      )}
      {...props}
    >
      {loading ? <ActivitySpinnerIcon aria-hidden="true" className="icon-xs" /> : null}
      {children}
    </button>
  );
}

export function PendingWorktreeRouteView({
  entry,
  resolution,
  busyAction = null,
  actionError = null,
  onCancel,
  onContinue,
  onAutoFix,
  onEditEnvironment,
  onRetry,
  onWorkLocally,
}: PendingWorktreeRouteViewProps) {
  const availableActions = resolvePendingWorktreeRouteActions(entry, resolution);
  const actionButtons =
    availableActions.canCancel ||
    availableActions.canAutoFix ||
    availableActions.canContinue ||
    availableActions.canEditEnvironment ||
    availableActions.canRetry ||
    availableActions.canWorkLocally ? (
      <>
        {availableActions.canWorkLocally ? (
          <PendingWorktreeActionButton
            tone="ghost"
            loading={busyAction === "work-locally" || busyAction === "cancel"}
            onClick={onWorkLocally}
          >
            <PendingWorktreeLocalIcon />
            Work locally
          </PendingWorktreeActionButton>
        ) : null}
        {availableActions.canCancel ? (
          <PendingWorktreeActionButton
            tone="ghost"
            loading={busyAction === "work-locally" || busyAction === "cancel"}
            onClick={onCancel}
          >
            <CloseIcon />
            Cancel
          </PendingWorktreeActionButton>
        ) : null}
        {availableActions.canEditEnvironment ? (
          <PendingWorktreeActionButton tone="secondary" onClick={onEditEnvironment}>
            Edit environment
          </PendingWorktreeActionButton>
        ) : null}
        {availableActions.canAutoFix ? (
          <PendingWorktreeActionButton
            tone="secondary"
            loading={busyAction === "auto-fix"}
            onClick={onAutoFix}
          >
            Auto-fix
          </PendingWorktreeActionButton>
        ) : null}
        {availableActions.canRetry ? (
          <PendingWorktreeActionButton tone="ghost" onClick={onRetry}>
            <RetryIcon />
            Retry
          </PendingWorktreeActionButton>
        ) : null}
        {availableActions.canContinue ? (
          <PendingWorktreeActionButton tone="primary" onClick={onContinue}>
            Continue anyway
          </PendingWorktreeActionButton>
        ) : null}
      </>
    ) : null;

  return (
    <div
      data-testid="pending-worktree-route-shell"
      data-pending-worktree-phase={entry.phase}
      className="h-full min-h-0 bg-token-main-surface-primary"
    >
      <EnsureLocalConversationThreadScrollController>
        <LocalConversationThreadScrollLayout>
          <div className="flex flex-col gap-4">
            <div className="group flex flex-col items-end gap-2">
              <div data-user-message-bubble="true" className={THREAD_VISUAL_TOKENS.userBubble}>
                <UserMessageText text={entry.prompt} />
              </div>
              <ThreadMessageActionRow align="end" className="opacity-100">
                <CopyMessageActionButton text={entry.prompt} />
              </ThreadMessageActionRow>
            </div>
            <PendingWorktreeProgress
              entry={entry}
              resolution={resolution}
              actions={actionButtons}
              actionError={actionError}
            />
          </div>
        </LocalConversationThreadScrollLayout>
      </EnsureLocalConversationThreadScrollController>
    </div>
  );
}

function PendingWorktreeRouteStatusSurface({
  error,
  onClose,
  onRetry,
}: {
  error: string | null;
  onClose: () => void;
  onRetry?: () => void;
}) {
  const loading = error === null && onRetry === undefined;
  const missing = error === null && onRetry !== undefined;
  return (
    <div
      data-testid="pending-worktree-route-shell"
      className="flex h-full min-h-0 items-center justify-center bg-token-main-surface-primary px-6"
    >
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        {loading ? <ActivitySpinnerIcon className="icon-sm text-tertiary" /> : null}
        <div className="text-sm font-medium text-token-foreground">
          {loading
            ? "Loading worktree setup…"
            : missing
              ? "Worktree setup is no longer available"
              : "Worktree setup could not be loaded"}
        </div>
        {error ? (
          <div role="alert" className="text-sm text-danger">
            {error}
          </div>
        ) : null}
        {!loading ? (
          <div className="flex gap-2">
            <NodexButton variant="secondary" size="sm" onClick={onClose}>
              Back
            </NodexButton>
            {error && onRetry ? (
              <NodexButton variant="primary" size="sm" onClick={onRetry}>
                Retry
              </NodexButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export interface PendingWorktreeRouteProps {
  clientThreadId: string;
  agentMode?: CodexAgentMode;
  externalHeader?: boolean;
  transport?: PendingWorktreeRouteTransport;
  onClose: () => void;
  onOpenThread: (threadId: string) => Promise<boolean | void>;
  onOpenPendingWorktree?: (clientThreadId: string) => void;
  onCancelToSource?: (entry: CodexPendingWorktreeEntry) => void | Promise<void>;
  onEditEnvironment?: (entry: CodexPendingWorktreeEntry) => void;
}

export function PendingWorktreeRoute({
  clientThreadId,
  agentMode = "auto",
  transport = pendingWorktreeRouteTransport,
  onClose,
  onOpenThread,
  onOpenPendingWorktree,
  onCancelToSource,
  onEditEnvironment,
}: PendingWorktreeRouteProps) {
  const [snapshot, setSnapshot] = useState<PendingWorktreeRouteSnapshot>(INITIAL_SNAPSHOT);
  const [busyAction, setBusyAction] = useState<PendingWorktreeRouteAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [workLocallyHidden, setWorkLocallyHidden] = useState(false);
  const loadSequenceRef = useRef(0);
  const openingThreadIdRef = useRef<string | null>(null);

  const load = useCallback(
    async (entriesOverride?: readonly CodexPendingWorktreeEntry[]) => {
      const sequence = loadSequenceRef.current + 1;
      loadSequenceRef.current = sequence;
      try {
        const [entries, resolution] = await Promise.all([
          entriesOverride ?? transport.list(),
          transport.resolveThread(clientThreadId),
        ]);
        if (loadSequenceRef.current !== sequence) return;
        const entry = findPendingWorktreeEntry(entries, clientThreadId);
        setSnapshot({
          status: entry || resolution ? "ready" : "missing",
          entry,
          resolution,
          errorMessage: null,
        });
      } catch (error) {
        if (loadSequenceRef.current !== sequence) return;
        setSnapshot({
          status: "error",
          entry: null,
          resolution: null,
          errorMessage: errorMessage(error),
        });
      }
    },
    [clientThreadId, transport],
  );

  useEffect(() => {
    setSnapshot(INITIAL_SNAPSHOT);
    setActionError(null);
    setBusyAction(null);
    setWorkLocallyHidden(false);
    openingThreadIdRef.current = null;
    void load();
    return transport.subscribe((entries) => {
      void load(entries);
    });
  }, [clientThreadId, load, transport]);

  const clearAttentionOnRouteEntry = useEffectEvent(() => {
    const entry = snapshot.entry;
    if (!entry) return;
    void transport.clearAttention(entry.hostId, entry.id).catch(() => undefined);
  });

  const pendingWorktreeId = snapshot.entry?.id ?? null;
  useEffect(() => {
    if (pendingWorktreeId === null) return;
    clearAttentionOnRouteEntry();
  }, [pendingWorktreeId]);

  const openResolvedThread = useCallback(
    (threadId: string) => {
      if (openingThreadIdRef.current === threadId) return;
      openingThreadIdRef.current = threadId;

      void onOpenThread(threadId)
        .then((opened) => {
          if (opened === false) {
            throw new Error("The created task could not be opened.");
          }
          onClose();
        })
        .catch((error) => {
          openingThreadIdRef.current = null;
          setActionError(errorMessage(error));
        });
    },
    [onClose, onOpenThread],
  );

  useEffect(() => {
    if (snapshot.resolution?.state !== "succeeded") return;
    openResolvedThread(snapshot.resolution.threadId);
  }, [openResolvedThread, snapshot.resolution]);

  const runAction = useCallback(
    async (action: PendingWorktreeRouteAction) => {
      const entry = snapshot.entry;
      const pendingWorktreeId = entry?.id;
      const hostId = entry?.hostId;
      if (!entry || !pendingWorktreeId || !hostId || busyAction !== null) return;
      setActionError(null);
      if (action === "work-locally") setWorkLocallyHidden(true);
      setBusyAction(action);
      try {
        if (action === "cancel") {
          await transport.cancel(hostId, pendingWorktreeId);
          await transport.discardForkSidePanelTransfer(pendingWorktreeId);
          await onCancelToSource?.(entry);
          onClose();
          return;
        }
        if (action === "work-locally") {
          const result = await transport.workLocally(hostId, pendingWorktreeId);
          openResolvedThread(result.threadId);
          return;
        }
        if (action === "auto-fix") {
          const result = await transport.autoFix(hostId, pendingWorktreeId, agentMode);
          if (!result.clientThreadId) {
            throw new Error("The worktree repair task has no client thread id.");
          }
          onOpenPendingWorktree?.(result.clientThreadId);
          return;
        }
        if (action === "continue") {
          await transport.continue(hostId, pendingWorktreeId);
        } else {
          await transport.retry(hostId, pendingWorktreeId);
        }
        await load();
      } catch (error) {
        if (action === "work-locally") setWorkLocallyHidden(false);
        const message = errorMessage(error);
        if (action === "auto-fix") {
          toast.danger("Error starting task", { description: message });
        }
        setActionError(message);
      } finally {
        setBusyAction(null);
      }
    },
    [
      agentMode,
      busyAction,
      load,
      onCancelToSource,
      onClose,
      onOpenPendingWorktree,
      openResolvedThread,
      snapshot.entry,
      transport,
    ],
  );

  if (workLocallyHidden && actionError === null) return null;
  if (snapshot.status === "loading") {
    return <PendingWorktreeRouteStatusSurface error={null} onClose={onClose} />;
  }
  if (snapshot.status === "error") {
    return (
      <PendingWorktreeRouteStatusSurface
        error={snapshot.errorMessage}
        onClose={onClose}
        onRetry={() => {
          setSnapshot(INITIAL_SNAPSHOT);
          void load();
        }}
      />
    );
  }
  if (!snapshot.entry) {
    if (snapshot.resolution?.state === "succeeded") {
      const resolvedThreadId = snapshot.resolution.threadId;
      if (actionError) {
        return (
          <PendingWorktreeRouteStatusSurface
            error={actionError}
            onClose={onClose}
            onRetry={() => {
              setActionError(null);
              openingThreadIdRef.current = null;
              openResolvedThread(resolvedThreadId);
            }}
          />
        );
      }
      return <PendingWorktreeRouteStatusSurface error={null} onClose={onClose} />;
    }
    if (actionError) {
      return <PendingWorktreeRouteStatusSurface error={actionError} onClose={onClose} />;
    }
    if (snapshot.resolution?.state === "waiting" || snapshot.resolution?.state === "starting") {
      return <PendingWorktreeRouteStatusSurface error={null} onClose={onClose} />;
    }
    if (snapshot.resolution?.state === "failed") {
      return (
        <PendingWorktreeRouteStatusSurface
          error={snapshot.resolution.errorMessage ?? "The local task could not be started."}
          onClose={onClose}
        />
      );
    }
    return (
      <PendingWorktreeRouteStatusSurface
        error={null}
        onClose={onClose}
        onRetry={() => {
          setSnapshot(INITIAL_SNAPSHOT);
          void load();
        }}
      />
    );
  }

  return (
    <PendingWorktreeRouteView
      entry={snapshot.entry}
      resolution={snapshot.resolution}
      busyAction={busyAction}
      actionError={actionError}
      onCancel={() => void runAction("cancel")}
      onContinue={() => void runAction("continue")}
      onAutoFix={() => void runAction("auto-fix")}
      onEditEnvironment={() => {
        if (snapshot.entry) onEditEnvironment?.(snapshot.entry);
      }}
      onRetry={() => void runAction("retry")}
      onWorkLocally={() => void runAction("work-locally")}
    />
  );
}
